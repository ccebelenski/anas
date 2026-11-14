/*
 * ANAS — Hybrid RAID (AHR) view. Epic 11 + AHR (docs/AHR-DESIGN.md §6.2).
 *
 * A native ExtJS grid of AHR pools (mdadm banded arrays → LVM → btrfs) with a
 * layered-stack detail panel below (the mounts grid+detail idiom): per-disk
 * bays showing band slices coloured per array, per-array rows with sync
 * progress, the VG/LV line and the btrfs line. Capacity is ALWAYS the labelled
 * AhrCapacity breakdown — never a bare number — and pendingBytes > 0 renders
 * the §5.2 "unlock" explanation with concrete sizes.
 *
 * Data (docs/AHR-DESIGN.md §4, shared shapes in packages/shared/src/schemas/ahr.ts):
 *   GET    /ahr                        → { data: AhrPool[] }
 *   GET    /ahr/:name                  → { data: AhrPool }
 *   POST   /ahr/:name/expand/plan      → { data: plan }   (dry-run, no mutation)
 *   POST   /ahr/:name/expand           → 409 confirm → 202 { job }
 *   POST   /ahr/:name/disk/:id/replace → 409 confirm → 202 { job }
 *   POST   /ahr/:name/scrub            → 202 { job }
 *   POST   /ahr/:name/cache            → 202 { job }   (attach read cache, ahrcache.1)
 *   DELETE /ahr/:name/cache            → 202 { job }   (detach read cache)
 *   POST   /ahr/:name/remount          → 409 confirm → 202 { job }
 *                                         (clear a btrfs forced-readonly mount,
 *                                          ahrcache.1 slice 2)
 *   DELETE /ahr/:name                  → 409 confirm → 202 { job }
 *
 * Mutation handlers degrade to a clear "not available in this build" message
 * when the daemon 404s a route (fail-open, never a raw error).
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
        return ANAS.enc(s);
    }
    function fmtBytes(n) {
        try {
            return ANAS.formatBytes(n);
        } catch (e) {
            return '' + n;
        }
    }

    // ---- facts read off the pool record (cr3) -------------------------------

    // cr3 (AHR-PANEL-M3): the daemon's "a btrfs scrub is running on this
    // pool" fact. During a scrub's btrfs pass no md check runs, so the fused
    // `state` alone reads healthy and the bands read idle. ONE field name and
    // ONE accessor: true = running, false = not running, null = absent (an
    // older daemon) or unknown (the read failed). Only `true` changes what is
    // shown; absent and null render exactly what the record says without it.
    var BTRFS_SCRUB_FIELD = 'btrfsScrubRunning';
    // cr3: the one sentence for the `unknown` pool state — on the detail and
    // on every verb the daemon refuses in it (expand, scrub, snapshots).
    var STATE_UNKNOWN_REASON = 'The pool\'s mount state could not be read (the kernel mount table), so whether '
        + 'its filesystem is read-only is not known. Expand, Scrub, Attach cache, Remount and snapshot actions wait until it can be read.';
    function recField(rec, key) {
        try {
            return (rec && typeof rec.get === 'function') ? rec.get(key) : (rec ? rec[key] : undefined);
        } catch (e) {
            return undefined;
        }
    }
    function btrfsScrubRunning(rec) {
        var v = recField(rec, BTRFS_SCRUB_FIELD);
        return typeof v === 'boolean' ? v : null;
    }
    // The state the State column, the detail header and the toolbar act on:
    // the daemon's fused state, with a running btrfs pass shown as the
    // `scrubbing` it is. Only `healthy` is lifted: every state the daemon's
    // ladder ranks above `scrubbing` (ahr-topology.ts) keeps its own badge.
    function effectivePoolState(state, rec) {
        return (state === 'healthy' && btrfsScrubRunning(rec) === true) ? 'scrubbing' : state;
    }

    // cr3 (AHR-PANEL-M2): an AHR pool's `mountpoint` is the LV device path
    // while it is not mounted (shared ahr.ts AhrPool.mountpoint), and its
    // used/free figures are only read off a mounted filesystem. Every mount,
    // used, free and fullness rendering is gated on BOTH: `mounted === true`
    // and the value being a number. Anything else reads "unknown", never 0.
    function poolMounted(rec) {
        return recField(rec, 'mounted') === true;
    }
    function knownBytes(v) {
        return (typeof v === 'number' && isFinite(v)) ? v : null;
    }
    function fsBytes(rec, cap, key) {
        return (poolMounted(rec) && cap) ? knownBytes(cap[key]) : null;
    }

    // cr3 (AHR-PANEL-M1): a band's RAID slots, counted as the daemon counts
    // them. A hot spare rides on an active array as a member row with
    // memberState `spare` (ahr-topology.ts buildAhrPoolBriefs, ahr-expand.ts
    // memberIds: "never counts toward band member totals"), and an
    // `mdadm --replace` target in flight is the row memberState `rebuilding`
    // (ahr-topology.ts maps mdstat's (R) there and nowhere else); neither is a
    // slot, which is how the daemon's own capacity math reads mdstat
    // (`!m.spare && !m.replacement`). Every member count and every usable
    // figure this file derives goes through this one function.
    function slotMembers(array) {
        var out = [];
        var members = (array && array.members) || [];
        for (var i = 0; i < members.length; i++) {
            var st = members[i] && members[i].memberState;
            if (st !== 'spare' && st !== 'rebuilding') {
                out.push(members[i]);
            }
        }
        return out;
    }
    // A band array that CANNOT START (ArrayState `inactive`: mdstat's
    // inactive, the GT-8 shape) lists EVERY member device as `(S)`, so every
    // row arrives memberState `spare`. Those are not hot spares and the
    // array has no running slots: its rows are never classified, it reads
    // "N member devices · not running", and no usable figure is derived for
    // it. Keyed on the daemon's array state (ahr-topology.ts arrayState: the
    // same `md.active === false` its spare mapping and the pool's offline
    // verdict read), never on the count.
    function arrayNotRunning(array) {
        return !!array && array.state === 'inactive';
    }
    function memberDevicesText(n) {
        return n + ' ' + t(n === 1 ? 'member device' : 'member devices');
    }
    // cr3: a band's SLOT count. md's own `raidDevices` (the n of mdstat's
    // [n/m]) when the daemon sends it: during a spare failover the spare being
    // rebuilt onto carries no marker and the failed member keeps its row, so
    // rows over-count. Absent (an inactive array, an older daemon): the rows
    // rule above.
    function slotCount(array) {
        var n = array ? array.raidDevices : undefined;
        return (typeof n === 'number' && isFinite(n) && n > 0) ? n : slotMembers(array).length;
    }
    // In-sync rows, capped at the slot count.
    function inSyncCount(array) {
        return Math.min(countMembers(array, 'in_sync'), slotCount(array));
    }
    function countMembers(array, memberState) {
        var n = 0;
        var members = (array && array.members) || [];
        for (var i = 0; i < members.length; i++) {
            if (members[i] && members[i].memberState === memberState) {
                n++;
            }
        }
        return n;
    }

    // cr3 (AHR-PANEL-L6): the disk ids serving any band of the pool, exactly
    // the daemon's membership test for expand and replace (ahr-expand.ts
    // memberIds: every array member row that is not a spare). A cache disk is
    // never in an array; a hot spare's rows are all `spare`.
    function poolMemberIds(d) {
        var out = {};
        var arrays = (d && d.arrays) || [];
        for (var i = 0; i < arrays.length; i++) {
            var members = arrays[i].members || [];
            for (var j = 0; j < members.length; j++) {
                if (members[j].memberState !== 'spare') {
                    out[members[j].disk] = true;
                }
            }
        }
        return out;
    }
    function poolMemberDisks(d) {
        var ids = poolMemberIds(d);
        var out = [];
        var pd = (d && d.disks) || [];
        for (var i = 0; i < pd.length; i++) {
            if (ids[pd[i].id] === true) {
                out.push({ id: pd[i].id, model: pd[i].model, size: pd[i].sizeBytes });
            }
        }
        return out;
    }

    // cr3 (AHR-PANEL-L5): the disk-candidacy predicate every AHR picker
    // filters through (the spare, cache, expand and replace pickers here and
    // the create composer's tray). cr3.followup: it is the ONE panel copy of
    // the shared `isComposableDisk`, ANAS.gfx.isComposableDisk (15-gfx.js,
    // which the ZFS pickers use too), read at call time; without it nothing
    // is offered.
    function composable(disk) {
        var g = ANAS.gfx;
        return !!(g && typeof g.isComposableDisk === 'function' && g.isComposableDisk(disk));
    }
    function composableDisks(all) {
        var out = [];
        for (var i = 0; i < (all || []).length; i++) {
            if (composable(all[i])) {
                out.push(all[i]);
            }
        }
        return out;
    }

    // ---- vocabulary ---------------------------------------------------------

    // Tier labels lead with the MEANING; the acronym is API vocabulary.
    var TIER_LABELS = {
        ahr1: '1-disk fault tolerance (AHR-1)',
        ahr2: '2-disk fault tolerance (AHR-2)',
    };
    function tierLabel(ahrType) {
        return t(TIER_LABELS[ahrType] || ('' + (ahrType || '')));
    }

    // Map an AhrPoolState to the gfx pill severity token + a human label.
    // 'resyncing' arrays after create are "building — pool usable now", so the
    // pool-level building/expanding/scrubbing states stay NEUTRAL (activity, not
    // fault) — 'building' especially: a mixed-media pool lives there for its
    // first hours-to-days while md serializes the band syncs, and an amber
    // fault pill for that whole window is a lie (issue #7).
    //
    // 'offline' is the other end of that same discipline (issue #18): a pool
    // whose volume cannot be assembled serves NOTHING, so it wears the RED pill
    // and an uppercase label — amber "degraded" beside a lowercase word read as
    // reduced-redundancy-but-functioning while the data was unreachable. WHICH
    // bands cannot start comes from the daemon's advisory, rendered verbatim by
    // advisoriesHtml() like every other pool advisory.
    // cr3 (INVENTED-STATE-H3, the daemon's tenth state): `unknown` — the
    // kernel mount table could not be read, so whether btrfs forced the
    // filesystem read-only is not known. A NEUTRAL pill: never healthy's
    // green, never an error colour (nothing is known to be wrong).
    var POOL_STATES = {
        unknown: { token: '', label: 'unknown' },
        healthy: { token: 'ONLINE', label: 'healthy' },
        building: { token: '', label: 'building' },
        degraded: { token: 'DEGRADED', label: 'degraded' },
        expanding: { token: '', label: 'expanding' },
        rebuilding: { token: 'DEGRADED', label: 'rebuilding' },
        scrubbing: { token: '', label: 'scrubbing' },
        offline: { token: 'OFFLINE', label: 'OFFLINE' },
        failed: { token: 'FAULTED', label: 'failed' },
        readonly: { token: 'FAULTED', label: 'read-only' },
    };

    // A state this panel does not know falls to a neutral pill carrying the
    // daemon's word — never healthy's green, never blank while a value exists.
    function renderPoolState(value) {
        var meta = POOL_STATES.hasOwnProperty(value) ? POOL_STATES[value] : { token: '', label: '' + (value || '') };
        try {
            var gfx = ANAS.gfx;
            if (gfx && typeof gfx.statePill === 'function' && value) {
                var html = gfx.statePill(meta.token, { label: t(meta.label) });
                if (html) {
                    return html;
                }
            }
        } catch (e) {
            // fall through
        }
        return enc(t(meta.label));
    }

    // Array-level state pill (clean/degraded/resyncing/...). Initial resync is
    // presented as "building" per the design note, distinct from degraded.
    //
    // 'inactive' is the band-level end of the pool's OFFLINE discipline: a band
    // that CANNOT START serves nothing, so it wears the red pill and says so in
    // the operator's words — "cannot start", the same phrase the daemon's
    // advisory and the dashboard card use. Only the bands that actually failed
    // to assemble go red; a sibling band that is genuinely up-and-degraded keeps
    // its amber, because WHICH band died is the fact recovery turns on.
    var ARRAY_STATES = {
        clean: { token: 'ONLINE', label: 'clean' },
        degraded: { token: 'DEGRADED', label: 'degraded' },
        resyncing: { token: '', label: 'building' },
        reshaping: { token: '', label: 'reshaping' },
        recovering: { token: 'DEGRADED', label: 'rebuilding' },
        inactive: { token: 'OFFLINE', label: 'CANNOT START' },
        failed: { token: 'FAULTED', label: 'failed' },
    };

    // A band laying down redundancy for the FIRST time is activity, not fault —
    // the operator's #7 ruling, applied one level down. `recovering` covers two
    // genuinely different situations and the tone must tell them apart:
    //
    //   • a fresh build → NEUTRAL "building": nothing has failed.
    //   • a rebuild after a disk failure → DEGRADED amber: redundancy really is
    //     reduced until it finishes. THIS DISTINCTION IS LOAD-BEARING.
    //
    // The discriminator is the POOL's state, not this array's members, and that
    // is deliberate: "no faulty member" is not a safe test. A rebuild onto a
    // spare comes in two shapes — the dead disk still attached and flagged
    // `(F)`, or the dead disk PULLED, in which case md stops listing it and
    // NOTHING in members[] looks wrong (readAhrPools never emits memberState
    // 'missing'). Pool state `building` means the daemon applied the issue #9
    // discriminator to every band using mdstat's raidDevices, which this
    // payload does not carry — the same rule, evaluated where the evidence is.
    //
    // KNOWN LIMIT, tested in ahr-topology.test.ts: the pulled-disk shape is
    // byte-identical to a fresh build in mdstat ([n/n-1], full device count, no
    // (F)), so when EVERY band is rebuilding after a pull this reads neutral
    // for what is really a degraded rebuild. The attached-(F) case — the common
    // one — is separated correctly. Fixing the rest needs a signal mdstat does
    // not have (array creation time is the candidate).
    function arrayStatePill(state, poolBuilding) {
        var meta = ARRAY_STATES[state] || { token: '', label: '' + (state || '') };
        if (state === 'recovering' && poolBuilding) {
            meta = { token: '', label: 'building' };
        }
        try {
            var gfx = ANAS.gfx;
            if (gfx && typeof gfx.statePill === 'function') {
                var html = gfx.statePill(meta.token, { label: t(meta.label) });
                if (html) {
                    return html;
                }
            }
        } catch (e) {
            // fall through
        }
        return enc(t(meta.label));
    }

    // Band → themed series colour (cycled, stable per band index).
    function bandColor(band) {
        var n = ((Number(band) || 1) - 1) % 5 + 1;
        return 'var(--anas-series-' + n + ')';
    }

    var HATCH = 'repeating-linear-gradient(45deg,var(--anas-free),var(--anas-free) 6px,'
        + 'var(--anas-slot) 6px,var(--anas-slot) 12px)';

    function fmtEta(seconds) {
        var s = Number(seconds);
        if (isNaN(s) || s < 0) {
            return '';
        }
        var h = Math.floor(s / 3600);
        var m = Math.floor((s % 3600) / 60);
        if (h > 0) {
            return h + 'h ' + m + 'm';
        }
        if (m > 0) {
            return m + 'm';
        }
        return Math.round(s) + 's';
    }

    function fmtSpeed(bps) {
        var v = Number(bps);
        if (isNaN(v) || v < 0) {
            return '';
        }
        return fmtBytes(v) + '/s';
    }

    var SYNC_LABELS = {
        resync: 'building',
        reshape: 'reshaping',
        recover: 'rebuilding',
        check: 'checking',
    };
    function syncLabel(action) {
        return t(SYNC_LABELS[action] || ('' + (action || '')));
    }

    // ---- capacity (the labelled breakdown — never a bare number) -----------

    function capOf(rec) {
        try {
            var v = (rec && typeof rec.get === 'function') ? rec.get('capacity') : (rec && rec.capacity);
            return v || null;
        } catch (e) {
            return null;
        }
    }

    // A filesystem figure, or "unknown" (M2: never a placeholder 0).
    function fsFigure(bytes) {
        return bytes === null ? t('unknown') : fmtBytes(bytes);
    }
    var UNKNOWN_CELL_STYLE = 'color:var(--anas-muted)';
    function unknownCell(rec) {
        return '<span style="' + UNKNOWN_CELL_STYLE + '" title="'
            + enc(poolMounted(rec) ? t('usage unknown') : t('not mounted — usage unknown')) + '">'
            + enc(t('unknown')) + '</span>';
    }

    // One-line labelled breakdown for tooltips.
    function capTooltip(cap, rec) {
        if (!cap) {
            return '';
        }
        var parts = [
            t('Usable') + ' ' + fsFigure(knownBytes(cap.usableBytes)),
            t('Raw') + ' ' + fmtBytes(cap.rawBytes),
            t('Redundancy overhead') + ' ' + fmtBytes(cap.redundancyOverheadBytes),
            t('Unprotected (wasted)') + ' ' + fmtBytes(cap.unprotectedWastedBytes),
        ];
        if (Number(cap.pendingBytes) > 0) {
            parts.push(t('Pending (locked)') + ' ' + fmtBytes(cap.pendingBytes));
        }
        parts.push(t('Used') + ' ' + fsFigure(fsBytes(rec, cap, 'usedBytes')));
        parts.push(t('Free') + ' ' + fsFigure(fsBytes(rec, cap, 'freeBytes')));
        return parts.join('  ·  ');
    }

    // Grid Usable column: usable prominent, the full labelled breakdown in the
    // tooltip, and an explicit "+pending" tag when capacity is locked (§5.2).
    function renderUsable(value, meta, record) {
        var cap = capOf(record);
        if (!cap) {
            return '';
        }
        // cr3: `usableBytes` is null when there is no LV or mounted
        // filesystem to measure — "unknown", never blank, never 0.
        var usableKnown = knownBytes(cap.usableBytes);
        var html = usableKnown === null
            ? '<span style="' + UNKNOWN_CELL_STYLE + '">' + enc(t('unknown')) + '</span>'
            : '<span style="font-weight:650">' + enc(fmtBytes(usableKnown)) + '</span>';
        if (Number(cap.pendingBytes) > 0) {
            html += ' <span style="color:var(--anas-warn);font-size:11px">+'
                + enc(fmtBytes(cap.pendingBytes) + ' ' + t('pending')) + '</span>';
        }
        try {
            if (meta) {
                meta.tdAttr = 'title="' + enc(capTooltip(cap, record)) + '"';
            }
        } catch (e) {
            // tooltip optional
        }
        return html;
    }

    // Grid Used / Free columns: the two numbers an operator checks free space
    // with, first-class beside Usable exactly as the ZFS Pools grid carries
    // Allocated/Free (issue #28 — capacity display is not a place AHR and ZFS
    // diverge). Blank when capacity is absent, matching renderUsable; an
    // unmounted pool or an unread figure reads "unknown" (cr3 M2).
    function renderUsed(value, meta, record) {
        var cap = capOf(record);
        if (!cap) {
            return '';
        }
        var used = fsBytes(record, cap, 'usedBytes');
        return used === null ? unknownCell(record) : enc(fmtBytes(used));
    }

    function renderFree(value, meta, record) {
        var cap = capOf(record);
        if (!cap) {
            return '';
        }
        var free = fsBytes(record, cap, 'freeBytes');
        return free === null ? unknownCell(record) : enc(fmtBytes(free));
    }

    // Grid Capacity column: used ÷ usable through the shared gfx bar — the same
    // call the ZFS grid makes, so the fullness thresholds are one definition
    // (gfx fillColorVar), not a second copy. Falls back to plain percent text.
    function renderCapacityPct(value, meta, record) {
        var cap = capOf(record);
        if (!cap) {
            return '';
        }
        var usable = knownBytes(cap.usableBytes);
        var used = fsBytes(record, cap, 'usedBytes');
        if (used === null || usable === null) {
            return unknownCell(record);
        }
        if (!(usable > 0)) {
            return '';
        }
        var frac = used / usable;
        var label = fmtBytes(used) + ' ' + t('used of') + ' ' + fmtBytes(usable) + ' ' + t('usable');
        try {
            var gfx = ANAS.gfx;
            if (gfx && typeof gfx.bar === 'function') {
                var html = gfx.bar(frac, { title: label });
                if (html) {
                    return html;
                }
            }
        } catch (e) {
            // fall through to text
        }
        return enc(ANAS.formatPercent(frac * 100));
    }

    // Grid Mount column. The shared gfx column prints `mountpoint` with a
    // "(not mounted)" suffix — right for ZFS, whose unmounted mountpoint is
    // still the configured directory. An unmounted AHR pool's `mountpoint`
    // is its LV device path (cr3 M2), so that row says "not mounted" alone.
    function renderMount(value, meta, record) {
        if (poolMounted(record)) {
            return enc(value || '');
        }
        return '<span style="color:var(--anas-warn);font-size:11px">('
            + enc(t('not mounted')) + ')</span>';
    }
    function ahrMountColumn() {
        var col = (ANAS.gfx && typeof ANAS.gfx.mountColumn === 'function')
            ? ANAS.gfx.mountColumn()
            : { text: t('Mount'), dataIndex: 'mountpoint', flex: 1, minWidth: 180, sortable: false, menuDisabled: true };
        col.renderer = renderMount;
        return col;
    }

    // ---- arrays / sync helpers ---------------------------------------------

    function arraysOf(rec) {
        try {
            var v = (rec && typeof rec.get === 'function') ? rec.get('arrays') : (rec && rec.arrays);
            return v && v.length ? v : [];
        } catch (e) {
            return [];
        }
    }

    function syncingArrays(arrays) {
        var out = [];
        for (var i = 0; i < (arrays || []).length; i++) {
            if (arrays[i] && arrays[i].sync) {
                out.push(arrays[i]);
            }
        }
        return out;
    }

    function activityHtml(frac, label, text) {
        try {
            var gfx = ANAS.gfx;
            if (gfx && typeof gfx.activity === 'function') {
                var html = gfx.activity(frac, { label: label });
                if (html) {
                    return html;
                }
            }
        } catch (e) {
            // fall through
        }
        return enc(text);
    }

    // Grid State column: the fused state, with a running btrfs pass read as
    // the scrub it is (cr3 M3).
    function renderGridState(value, meta, record) {
        return renderPoolState(effectivePoolState(value, record));
    }

    // Grid Activity column: an activity strip while any band array syncs
    // (percent from the busiest array), a btrfs scrub pass when the daemon
    // says one runs (no percent: the record carries none), else a muted Idle.
    function renderActivity(value, meta, record) {
        var syncing = syncingArrays(arraysOf(record));
        var btrfsScrub = btrfsScrubRunning(record) === true;
        if (!syncing.length) {
            if (btrfsScrub) {
                return activityHtml(null, t('scrubbing (btrfs)'), t('scrubbing (btrfs)'));
            }
            return '<span style="color:var(--anas-muted)">' + enc(t('Idle')) + '</span>';
        }
        var a = syncing[0];
        var label = syncLabel(a.sync.action) + ' ' + t('band') + ' ' + a.band;
        if (syncing.length > 1) {
            label += ' (+' + (syncing.length - 1) + ')';
        }
        if (btrfsScrub) {
            label += ' · ' + t('scrubbing (btrfs)');
        }
        var pc = Number(a.sync.percent);
        try {
            var gfx = ANAS.gfx;
            if (gfx && typeof gfx.activity === 'function') {
                var html = gfx.activity(isNaN(pc) ? null : pc / 100, { label: label });
                if (html) {
                    return html;
                }
            }
        } catch (e) {
            // fall through
        }
        return enc(label + (isNaN(pc) ? '' : ' ' + Math.round(pc) + '%'));
    }

    // Disk ids with a faulty/missing member in any array (drives the bay
    // highlight — a faulted disk lights up everywhere it participates).
    function faultedDiskIds(d) {
        var bad = {};
        var arrays = (d && d.arrays) || [];
        for (var i = 0; i < arrays.length; i++) {
            var members = arrays[i].members || [];
            for (var j = 0; j < members.length; j++) {
                var st = members[j].memberState;
                if (st === 'faulty' || st === 'missing') {
                    bad[members[j].disk] = true;
                }
            }
        }
        return bad;
    }

    // ---- detail panel builders ---------------------------------------------

    var SEC = 'margin:14px 0 8px;font-size:11px;font-weight:800;text-transform:uppercase;'
        + 'letter-spacing:.5px;color:var(--anas-muted)';

    function headerHtml(d) {
        var pill = renderPoolState(effectivePoolState(d.state, d));
        var tier = '<span style="font-size:12px;color:var(--anas-muted)">'
            + enc(tierLabel(d.ahrType)) + '</span>';
        return '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px">'
            + '<span style="font-weight:750;font-size:15px;color:var(--anas-ink)">' + enc(d.name) + '</span>'
            + pill + tier + '</div>';
    }

    // Counters are read, not calculated on: group them in threes so a
    // seven-digit hit count is legible at a glance. Grouping is done here
    // rather than through toLocaleString so the separator does not move with
    // the node's locale between one panel and the next.
    function fmtCount(n) {
        var v = Number(n);
        if (!isFinite(v)) {
            return '' + n;
        }
        return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function capRow(label, value, emphasis) {
        return '<div style="display:flex;justify-content:space-between;gap:14px;padding:3px 0">'
            + '<span style="color:var(--anas-muted)">' + enc(label) + '</span>'
            + '<span style="font-variant-numeric:tabular-nums;'
            + (emphasis ? 'font-weight:750' : 'font-weight:600') + '">' + enc(value) + '</span></div>';
    }

    function capacityHtml(d) {
        var cap = d.capacity || {};
        var usableKnown = knownBytes(cap.usableBytes);
        var usable = usableKnown === null ? 0 : usableKnown;
        // cr3 M2: the gauge is filesystem usage, read only off a mounted
        // pool; without that figure there is no gauge and the line says why.
        var used = fsBytes(d, cap, 'usedBytes');
        var gauge = '';
        if (used !== null && usable > 0) {
            try {
                var gfx = ANAS.gfx;
                if (gfx && typeof gfx.gauge === 'function') {
                    gauge = gfx.gauge(used / usable, {
                        label: fmtBytes(used) + ' ' + t('used of') + ' ' + fmtBytes(usable) + ' ' + t('usable'),
                        title: t('Filesystem usage'),
                    }) || '';
                }
            } catch (e) {
                gauge = '';
            }
        }
        var usageNote = used === null
            ? '<div style="margin-bottom:8px;color:var(--anas-muted)">'
                + enc(poolMounted(d) ? t('Filesystem usage unknown') : t('Not mounted — usage unknown'))
                + '</div>'
            : '';
        var rows = capRow(t('Usable'), fsFigure(usableKnown), true)
            + capRow(t('Free'), fsFigure(fsBytes(d, cap, 'freeBytes')))
            + capRow(t('Raw (all member disks)'), fmtBytes(cap.rawBytes))
            + capRow(t('Redundancy overhead'), fmtBytes(cap.redundancyOverheadBytes))
            + capRow(t('Unprotected (wasted)'), fmtBytes(cap.unprotectedWastedBytes));
        if (Number(cap.pendingBytes) > 0) {
            rows += capRow(t('Pending (locked)'), fmtBytes(cap.pendingBytes));
        }
        return '<div style="max-width:420px">'
            + (gauge ? '<div style="margin-bottom:8px">' + gauge + '</div>' : '')
            + usageNote + rows + '</div>';
    }

    // §5.2 pending-capacity unlock explanation — the single most confusing
    // thing hybrid RAID does, so it is named concretely: how much is locked,
    // and what to add to unlock it. Best-effort concreteness from the pool's
    // own disk sizes (the largest disk defines the boundary to cross).
    function pendingHtml(d) {
        var cap = d.capacity || {};
        var pending = Number(cap.pendingBytes) || 0;
        if (!(pending > 0)) {
            return '';
        }
        var largest = 0;
        var disks = d.disks || [];
        for (var i = 0; i < disks.length; i++) {
            var u = Number(disks[i].usableBytes) || 0;
            if (u > largest) {
                largest = u;
            }
        }
        var msg = '<b>' + enc(fmtBytes(pending) + ' ' + t('is installed but not usable yet.')) + '</b> '
            + enc(t('Too few disks reach the top capacity band to form a protected array.'))
            + (largest > 0
                ? (' ' + enc(t('Add or upgrade one more disk to') + ' ')
                    + '<b>≥ ' + enc(fmtBytes(largest)) + '</b> '
                    + enc(t('to unlock up to') + ' ~' + fmtBytes(pending)
                        + ' ' + t('of protected capacity.')))
                : '');
        try {
            var gfx = ANAS.gfx;
            if (gfx && typeof gfx.callout === 'function') {
                var html = gfx.callout(msg, { level: 'warn' });
                if (html) {
                    return '<div style="margin:10px 0">' + html + '</div>';
                }
            }
        } catch (e) {
            // fall through
        }
        return '<div style="margin:10px 0;color:var(--anas-warn)">' + msg + '</div>';
    }

    // Pool advisories from the daemon, rendered verbatim as warning callouts.
    // A live expansion intent (§6.2) leads the list: halted = loud, running =
    // informational (the jobs strip carries progress).
    function advisoriesHtml(d) {
        var adv = (d.advisories || []).slice();
        var exp = d.expansion;
        if (exp && exp.state === 'halted') {
            adv.unshift(t('An expansion is HALTED mid-flight — the pool is stable at its current layout. Use Resume (safe, re-computes and continues) or Abandon in the toolbar.'));
        } else if (exp && exp.state === 'running') {
            adv.unshift(t('An expansion is running — the pool stays online; progress is in the job.'));
        }
        if (!adv.length) {
            return '';
        }
        var html = '';
        for (var i = 0; i < adv.length; i++) {
            try {
                var gfx = ANAS.gfx;
                var c = (gfx && typeof gfx.callout === 'function')
                    ? gfx.callout(enc(adv[i]), { level: 'warn' })
                    : '';
                html += c || ('<div style="color:var(--anas-warn);font-size:12px;margin:4px 0">'
                    + enc(adv[i]) + '</div>');
            } catch (e) {
                html += '<div style="color:var(--anas-warn);font-size:12px;margin:4px 0">'
                    + enc(adv[i]) + '</div>';
            }
        }
        return '<div style="margin:10px 0;display:flex;flex-direction:column;gap:6px">' + html + '</div>';
    }

    // One disk's band-slice bar: each partition a segment coloured by its band,
    // width proportional to size; the unpartitioned remainder (the raw region
    // above the top array boundary, §2.6) hatched/grey with a label.
    function diskSliceBar(disk, maxBytes, sliceBytes) {
        var total = Number(disk.usableBytes) || Number(disk.sizeBytes) || 0;
        if (!(total > 0) || !(maxBytes > 0)) {
            return '';
        }
        // A cache disk (ahrcache.1) carries ONE slice that backs no band —
        // `partitions` is [] for it by schema, and rendering the default hatch
        // would read the whole disk as unused. The segment is the SLICE, whose
        // size the pool's `cache` reports (§13): a reclaimed hand-cut slice is
        // smaller than the disk it sits on, and labelling the disk's size there
        // would name flash the cache does not have. Without a slice figure the
        // whole disk is the honest picture. The bar is clipped to the member
        // scale — a cache disk taller than every member is not a wider bar.
        if (disk.role === 'cache') {
            var slice = Number(sliceBytes) || 0;
            if (!(slice > 0) || slice > total) {
                slice = total;
            }
            var cw = Math.min(100, (total / maxBytes) * 100);
            var fill = Math.min(100, (slice / total) * 100);
            var rest = 100 - fill;
            return '<span style="display:inline-flex;width:' + cw.toFixed(2) + '%;height:20px;'
                + 'border-radius:5px;overflow:hidden;border:1px solid var(--anas-card-edge);'
                + 'background:var(--anas-slot)">'
                + '<span title="' + enc(t('read cache') + ' — ' + fmtBytes(slice)) + '"'
                + ' style="display:inline-flex;align-items:center;justify-content:center;'
                + 'width:' + fill.toFixed(2) + '%;height:100%;background:var(--anas-accent);'
                + 'color:#fff;font-size:9.5px;font-weight:700;overflow:hidden;white-space:nowrap">'
                + (cw * fill / 100 > 6 ? enc(t('cache')) : '') + '</span>'
                + (rest > 0.5
                    ? '<span title="' + enc(t('unallocated') + ' — ' + fmtBytes(total - slice)) + '"'
                        + ' style="display:inline-flex;width:' + rest.toFixed(2) + '%;height:100%;'
                        + 'background:' + HATCH + '"></span>'
                    : '')
                + '</span>';
        }
        var parts = (disk.partitions || []).slice();
        parts.sort(function (a, b) {
            return (a.band || 0) - (b.band || 0);
        });
        var segs = '';
        var allocated = 0;
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i];
            var sz = Number(p.sizeBytes) || 0;
            allocated += sz;
            var w = (sz / maxBytes) * 100;
            segs += '<span title="' + enc(t('band') + ' ' + p.band + ' — ' + fmtBytes(sz)
                + ' (' + p.device + ')') + '"'
                + ' style="display:inline-flex;align-items:center;justify-content:center;'
                + 'width:' + w.toFixed(2) + '%;height:100%;background:' + bandColor(p.band) + ';'
                + 'color:#fff;font-size:9.5px;font-weight:700;overflow:hidden;white-space:nowrap;'
                + 'border-right:1px solid var(--anas-panel)">'
                + (w > 6 ? 'b' + enc('' + p.band) : '') + '</span>';
        }
        var rest = total - allocated;
        if (rest > 0 && (rest / maxBytes) > 0.005) {
            var rw = (rest / maxBytes) * 100;
            segs += '<span title="' + enc(t('unallocated') + ' — ' + fmtBytes(rest)) + '"'
                + ' style="display:inline-flex;align-items:center;justify-content:center;'
                + 'width:' + rw.toFixed(2) + '%;height:100%;background:' + HATCH + ';'
                + 'color:var(--anas-muted);font-size:9.5px;overflow:hidden;white-space:nowrap">'
                + (rw > 12 ? enc(t('unused')) : '') + '</span>';
        }
        var barW = (total / maxBytes) * 100;
        return '<span style="display:inline-flex;width:' + barW.toFixed(2) + '%;height:20px;'
            + 'border-radius:5px;overflow:hidden;border:1px solid var(--anas-card-edge);'
            + 'background:var(--anas-slot)">' + segs + '</span>';
    }

    // Per-disk bays: one gfx.bay per disk (full by-id in the label — never
    // truncated), the slice bar inside, model/size beneath. A faulted disk's
    // bay is outlined in danger red. Hot spares (§11) render in their OWN
    // labelled bay group — excluded from raw capacity, labelled as the
    // automatic rebuild target, never mixed in with the members.
    function disksHtml(d) {
        var gfx = ANAS.gfx;
        if (!gfx || typeof gfx.bay !== 'function' || typeof gfx.bayGroup !== 'function') {
            return '';
        }
        var disks = d.disks || [];
        if (!disks.length) {
            return '';
        }
        var bad = faultedDiskIds(d);
        // The slice bars are scaled against the tallest MEMBER (or spare — a
        // spare really carries the band geometry). A cache disk backs no band,
        // so letting it set the scale would shrink every member's bar to a
        // fraction of a disk that has nothing to do with the layout.
        var maxBytes = 0;
        var i;
        for (i = 0; i < disks.length; i++) {
            if (disks[i].role === 'cache') {
                continue;
            }
            var u = Number(disks[i].usableBytes) || Number(disks[i].sizeBytes) || 0;
            if (u > maxBytes) {
                maxBytes = u;
            }
        }
        // The cache slice's own size (§13 reports it once, on the cache, where
        // it belongs — a reclaimed hand-cut slice is smaller than its disk).
        // Attributable only when ONE disk carries the cache.
        var cacheSliceBytes = 0;
        if (d.cache && d.cache.devices && d.cache.devices.length === 1) {
            cacheSliceBytes = Number(d.cache.sizeBytes) || 0;
        }
        function bayFor(disk) {
            var faulted = !!bad[disk.id];
            var sub = (disk.model ? disk.model + ' · ' : '')
                + fmtBytes(disk.usableBytes || disk.sizeBytes)
                + (disk.role === 'spare'
                    ? ' · ' + t('hot spare — automatic rebuild target on any member failure')
                    : '')
                + (disk.role === 'cache'
                    ? ' · ' + t('read cache — the slice is wiped on detach')
                    : '');
            var inner = '<div style="width:100%;min-width:340px">'
                + '<div style="display:block;margin-bottom:5px">'
                + diskSliceBar(disk, maxBytes, disk.role === 'cache' ? cacheSliceBytes : 0) + '</div>'
                + '<div style="font-size:11px;color:var(--anas-muted)">' + enc(sub)
                + (faulted ? ' · <b style="color:var(--anas-danger)">' + enc(t('FAULTED')) + '</b>' : '')
                + '</div></div>';
            var bay = gfx.bay(disk.id, inner) || '';
            if (!bay) {
                return '';
            }
            if (faulted) {
                bay = '<div title="' + enc(disk.id + ' — ' + t('faulted member')) + '"'
                    + ' style="outline:2px solid var(--anas-danger);border-radius:11px">' + bay + '</div>';
            }
            return '<div style="flex:1 1 380px;max-width:640px">' + bay + '</div>';
        }
        var memberBays = '';
        var spareBays = '';
        var cacheBays = '';
        for (i = 0; i < disks.length; i++) {
            if (disks[i].role === 'spare') {
                spareBays += bayFor(disks[i]);
            } else if (disks[i].role === 'cache') {
                // ahrcache.1: the cache disk backs no band — its own labelled
                // group, parallel to the spares', never mixed into "band
                // slices" where its empty partition list would lie.
                cacheBays += bayFor(disks[i]);
            } else {
                memberBays += bayFor(disks[i]);
            }
        }
        var html = memberBays ? (gfx.bayGroup(t('Disks — band slices'), memberBays) || '') : '';
        if (spareBays) {
            html += gfx.bayGroup(t('Hot spare bay — excluded from capacity'), spareBays) || '';
        }
        if (cacheBays) {
            html += gfx.bayGroup(t('Cache disk — read cache, not a band member'), cacheBays) || '';
        }
        return html;
    }

    // ---- band members (11.18) -----------------------------------------------

    // One-time <style> for the member expander (scoped; injected once — the
    // 38-pool-composer ensureComposerStyle idiom). Needed because a marker that
    // flips with the open state is a CSS-state rule, not an inline style.
    function ensureAhrStyle() {
        try {
            if (document.getElementById('anas-ahr-style')) {
                return;
            }
            var css = '.anas-ahr-mem>summary{list-style:none;cursor:pointer;display:flex;'
                + 'align-items:center;gap:5px;width:fit-content;user-select:none;'
                + 'font-size:11.5px;color:var(--anas-muted)}'
                + '.anas-ahr-mem>summary::-webkit-details-marker{display:none}'
                + '.anas-ahr-mem>summary::before{content:"\\25B8";display:inline-block;'
                + 'width:9px;font-size:10px;line-height:1}'
                + '.anas-ahr-mem[open]>summary::before{content:"\\25BE"}'
                + '.anas-ahr-mem>summary:hover{color:var(--anas-ink)}'
                + '.anas-ahr-mem>summary:focus-visible{outline:1px solid var(--anas-accent);'
                + 'outline-offset:2px;border-radius:3px}'
                + '.anas-ahr-mem[open]>summary .anas-ahr-mem-c{display:none}'
                + '.anas-ahr-mem:not([open])>summary .anas-ahr-mem-o{display:none}';
            var style = document.createElement('style');
            style.id = 'anas-ahr-style';
            style.type = 'text/css';
            style.appendChild(document.createTextNode(css));
            (document.head || document.documentElement).appendChild(style);
        } catch (e) {
            // non-fatal — without it the expander still opens, just unstyled
        }
    }

    // Per-member state. faulty/missing are the two that mean something is
    // wrong; they carry the file's danger treatment. 'spare' is included
    // because hot-spare slices really are members of every band (§11) — the
    // list reports what md reports, never a curated subset.
    var MEMBER_STATES = {
        in_sync: { label: 'in sync', danger: false },
        rebuilding: { label: 'rebuilding', danger: false },
        spare: { label: 'spare', danger: false },
        faulty: { label: 'faulty', danger: true },
        missing: { label: 'missing', danger: true },
    };

    function memberStateHtml(state) {
        var meta = MEMBER_STATES[state] || { label: '' + (state || ''), danger: false };
        var css = 'font-size:11px;flex:0 0 auto;'
            + (meta.danger
                ? 'color:var(--anas-danger);font-weight:700'
                : 'color:var(--anas-muted)');
        return '<span style="' + css + '">' + enc(t(meta.label)) + '</span>';
    }

    // ", 1 spare" / ", 2 spares" / ", 1 replacing" — the rows on a band that
    // are not slots. Nothing on an array that is not running (its rows are
    // not classified, see arrayNotRunning).
    function extraRowsText(a) {
        if (arrayNotRunning(a)) {
            return '';
        }
        var spares = countMembers(a, 'spare');
        var replacing = countMembers(a, 'rebuilding');
        return (spares ? ', ' + spares + ' ' + t(spares === 1 ? 'spare' : 'spares') : '')
            + (replacing ? ', ' + replacing + ' ' + t('replacing') : '');
    }

    // Which partitions actually form this band (11.18). Collapsed by default so
    // the array row keeps its shape; a native <details> carries the open state,
    // so there is no bespoke expander machinery and nothing to lose across a
    // Reload. AHR diverges from the ZFS vdev rows here on purpose: ZFS members
    // are whole leaf devices, AHR members are partitions.
    function membersHtml(a) {
        var members = a.members || [];
        if (!members.length) {
            return '';
        }
        var notRunning = arrayNotRunning(a);
        var lines = '';
        for (var i = 0; i < members.length; i++) {
            var m = members[i];
            // An array that cannot start labels every row (S): that is the
            // array's state, not a hot spare (cr3 review follow-up 1).
            var rowState = (notRunning && m.memberState === 'spare')
                ? '<span style="font-size:11px;flex:0 0 auto;color:var(--anas-muted)">'
                    + enc(t('not running')) + '</span>'
                : memberStateHtml(m.memberState);
            // NEVER truncated: the by-id embeds the disk identity, which is the
            // entire reason to show it. Long ids wrap instead of being clipped.
            lines += '<div style="display:flex;gap:8px;align-items:baseline;padding:2px 0">'
                + '<span style="font-size:11.5px;color:var(--anas-ink);word-break:break-all">'
                + enc(m.partition || m.disk || '—') + '</span>'
                + '<span style="flex:1"></span>'
                + rowState + '</div>';
        }
        // cr3 M1: the count is the band's slots; spare and replacement rows
        // are listed (each wears its own state) and counted apart. An array
        // that is not running has member devices, not slots.
        var slots = slotCount(a);
        var count = notRunning
            ? memberDevicesText(members.length)
            : slots + ' ' + t(slots === 1 ? 'member' : 'members') + extraRowsText(a);
        return '<details class="anas-ahr-mem" style="margin-top:7px">'
            + '<summary><span class="anas-ahr-mem-c">' + enc(count) + '</span>'
            + '<span class="anas-ahr-mem-o">' + enc(t('members')) + '</span></summary>'
            + '<div style="margin:5px 0 1px 14px;padding-left:9px;'
            + 'border-left:2px solid var(--anas-line)">' + lines + '</div>'
            + '</details>';
    }

    // Per-array rows: band swatch, md device, level × members, state pill, the
    // sync progress strip (percent / speed / ETA) while a sync runs, and the
    // collapsed member list (11.18).
    function arraysHtml(d) {
        var arrays = (d.arrays || []).slice();
        if (!arrays.length) {
            return '';
        }
        arrays.sort(function (a, b) {
            return (a.band || 0) - (b.band || 0);
        });
        ensureAhrStyle();
        var rows = '';
        for (var i = 0; i < arrays.length; i++) {
            var a = arrays[i];
            // cr3 M1: level × SLOTS, "n in sync" (in-sync rows, capped at the
            // slot count).
            var slots = slotCount(a);
            var inSync = inSyncCount(a);
            var sw = '<span style="width:11px;height:11px;border-radius:3px;flex:0 0 auto;'
                + 'background:' + bandColor(a.band) + '"></span>';
            var head = sw
                + '<span style="font-weight:650;font-variant-numeric:tabular-nums">'
                + enc(a.device || (t('band') + ' ' + a.band)) + '</span>'
                + '<span style="color:var(--anas-muted);font-size:12px">'
                + enc((arrayNotRunning(a)
                    ? (a.level || '') + ' · ' + memberDevicesText((a.members || []).length)
                        + ' · ' + t('not running')
                    : (a.level || '') + ' × ' + slots
                        + (inSync < slots ? ' (' + inSync + ' ' + t('in sync') + ')' : '')
                        + extraRowsText(a))
                    + ' · ' + t('height') + ' ' + fmtBytes(a.heightBytes)) + '</span>'
                + '<span style="flex:1"></span>'
                + arrayStatePill(a.state, d.state === 'building');
            var syncHtml = '';
            if (a.sync) {
                var pc = Number(a.sync.percent);
                var strip = '';
                try {
                    var gfx = ANAS.gfx;
                    if (gfx && typeof gfx.activity === 'function') {
                        strip = gfx.activity(isNaN(pc) ? null : pc / 100,
                            { label: syncLabel(a.sync.action) }) || '';
                    }
                } catch (e) {
                    strip = '';
                }
                var stats = [];
                if (!isNaN(pc)) {
                    stats.push(pc.toFixed(1) + '%');
                }
                var sp = fmtSpeed(a.sync.speedBytesSec);
                if (sp) {
                    stats.push(sp);
                }
                var eta = fmtEta(a.sync.etaSeconds);
                if (eta) {
                    stats.push(t('ETA') + ' ' + eta);
                }
                syncHtml = '<div style="margin-top:6px">' + strip
                    + '<div style="font-size:11px;color:var(--anas-muted);margin-top:3px;'
                    + 'font-variant-numeric:tabular-nums">' + enc(stats.join('  ·  ')) + '</div></div>';
            }
            rows += '<div style="padding:8px 10px;border:1px solid var(--anas-line);border-radius:9px;'
                + 'margin-bottom:6px;background:var(--anas-panel)">'
                + '<div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">' + head + '</div>'
                + syncHtml + membersHtml(a) + '</div>';
        }
        return '<div style="' + SEC + '">' + enc(t('Band arrays (mdadm)')) + '</div>' + rows;
    }

    function lvmHtml(d) {
        var vg = d.vg || {};
        var lv = d.lv || {};
        // The VG's own size is NOT shown, and that is the point (GT-23,
        // ahrcache.1): the pool VG carries the band arrays AND, on a cached
        // pool, the cache slice — so `vg.sizeBytes` legitimately exceeds the
        // pool by the size of the flash, and read as a pool figure it is
        // simply wrong. Capacity comes from the LV the filesystem sits on,
        // here and in the capacity block above, never from the VG.
        return '<div style="' + SEC + '">' + enc(t('Volume (LVM)')) + '</div>'
            + '<div style="font-size:12.5px;color:var(--anas-ink)">'
            + enc(t('VG') + ' ' + (vg.name || '—')
                + '  ·  ' + t('LV') + ' ' + (lv.name || '—') + ' — ' + fsFigure(knownBytes(lv.sizeBytes)))
            + '</div>';
    }

    // cr3 M2: "mounted at" only for a mounted pool — an unmounted pool's
    // `mountpoint` is its LV device path, not a directory.
    function fsHtml(d) {
        var cap = d.capacity || {};
        var line = poolMounted(d)
            ? 'btrfs — ' + t('mounted at') + ' ' + (d.mountpoint || '—')
                + '  ·  ' + fsFigure(fsBytes(d, cap, 'usedBytes')) + ' ' + t('used') + ', '
                + fsFigure(fsBytes(d, cap, 'freeBytes')) + ' ' + t('free')
            : 'btrfs — ' + t('not mounted — usage unknown');
        return '<div style="' + SEC + '">' + enc(t('Filesystem (btrfs)')) + '</div>'
            + '<div style="font-size:12.5px;color:var(--anas-ink)">' + enc(line) + '</div>';
    }

    // ---- read cache (ahrcache.1, AHR-DESIGN §13) ----------------------------

    // The pool detail's Cache block. Version skew first (the shared schema's
    // own ruling): a payload with no `cache` field is a daemon that predates
    // ahrcache.1 — that reads "this daemon cannot tell me", never "there is
    // no cache", so the whole section stays off rather than saying no.
    //
    // State line per state:
    //   absent  → muted "no cache"; a leftover <pool>-cache<n> slice (the
    //             died-and-returned device's mark, §13) names the disks and
    //             both verbs that can clear or reuse it.
    //   failed  → the red line in GT-19's own words (dm-cache does NOT fall
    //             through to the origin — every read returns an I/O error
    //             until the cache is detached), matching the daemon's
    //             advisory sentence exactly.
    //   inactive → the pool volume is not active, so the cache's health
    //             cannot be read; a muted line, no verdict (the pool's own
    //             offline advisory says why the volume is down).
    //   healthy → the ONLINE pill, then the counters — which the schema only
    //             carries on healthy (a stale number presented as live is the
    //             failure GT-23 caught, so the fields are simply absent
    //             otherwise and nothing is invented here).
    function cacheHtml(d) {
        var c = d.cache;
        if (!c) {
            return '';
        }
        var stateHtml;
        var extra = '';
        // An absent cache has no devices, no size and no mode — the schema
        // sends 0/'' there, and rendering the rows anyway reads "device
        // missing · 0 B · writethrough", three facts about a cache that does
        // not exist. The state line is the whole truth. The leftover slice is
        // the one absent shape with real numbers (the device and the size of
        // the slice still on it), so it keeps those two rows — and only those.
        var describable = c.state !== 'absent';
        var leftover = c.state === 'absent' && !!(c.devices && c.devices.length);
        if (c.state === 'absent') {
            stateHtml = '<span style="color:var(--anas-muted)">' + enc(t('no cache')) + '</span>';
            if (c.devices && c.devices.length) {
                extra = '<div style="font-size:12px;color:var(--anas-warn);margin-top:4px">'
                    + enc(t('A leftover cache slice sits on') + ' ' + c.devices.join(', ') + ' — '
                        + t('Attach cache… reuses it; Detach cache deletes it and the disk reads available again'))
                    + '</div>';
            }
        } else if (c.state === 'failed') {
            stateHtml = '<span style="color:var(--anas-danger);font-weight:700">'
                + enc(t('cache device failed — every read returns an I/O error until the cache is detached (Detach cache)'))
                + '</span>';
        } else if (c.state === 'inactive') {
            stateHtml = '<span style="color:var(--anas-muted)">'
                + enc(t('health unknown — the pool volume is not active, so the cache cannot be read'))
                + '</span>';
        } else {
            stateHtml = renderPoolState('healthy');
        }
        var rows = '';
        if (describable || leftover) {
            rows += capRow(t('Devices'),
                (c.devices && c.devices.length) ? c.devices.join(', ') : t('device missing'));
            rows += capRow(leftover ? t('Slice size') : t('Cache size'), fmtBytes(c.sizeBytes));
        }
        if (describable) {
            rows += capRow(t('Mode'),
                c.mode + ' — ' + t('read cache; every write lands on the pool before it is acknowledged'));
            if (c.policy) {
                rows += capRow(t('Policy'), c.policy);
            }
        }
        if (c.state === 'healthy') {
            var hits = Number(c.hits);
            var misses = Number(c.misses);
            if (!isNaN(hits) && !isNaN(misses)) {
                var total = hits + misses;
                var ratio = total > 0 ? ANAS.formatPercent((hits / total) * 100) : '—';
                rows += capRow(t('Hits / misses (hit ratio)'),
                    fmtCount(hits) + ' / ' + fmtCount(misses) + ' (' + ratio + ')');
            }
            var used = c.usedBlocks;
            var totalBlocks = c.totalBlocks;
            if (used !== undefined && totalBlocks !== undefined) {
                // How full the cache is, which is the question the figure
                // answers; the raw counts stay one hover away rather than
                // asking the reader to divide six-digit numbers in their head.
                var fullPct = Number(totalBlocks) > 0
                    ? ANAS.formatPercent((Number(used) / Number(totalBlocks)) * 100)
                    : '—';
                rows += '<div title="' + enc(fmtCount(used) + ' ' + t('of') + ' '
                        + fmtCount(totalBlocks) + ' ' + t('cache blocks hold data')) + '"'
                    + ' style="display:flex;justify-content:space-between;gap:14px;padding:3px 0">'
                    + '<span style="color:var(--anas-muted)">' + enc(t('Cache blocks used')) + '</span>'
                    + '<span style="font-variant-numeric:tabular-nums;font-weight:600">'
                    + enc(fullPct) + '</span></div>';
            }
            var dirty = c.dirtyBlocks;
            if (dirty !== undefined) {
                // Zero by construction in writethrough — a non-zero figure is
                // a bug, not a state to normalize (shared schema ruling).
                rows += '<div style="display:flex;justify-content:space-between;gap:14px;padding:3px 0">'
                    + '<span style="color:var(--anas-muted)">' + enc(t('Dirty blocks')) + '</span>'
                    + '<span style="font-variant-numeric:tabular-nums;font-weight:600;'
                    + (Number(dirty) > 0 ? 'color:var(--anas-danger)">' + enc(fmtCount(dirty))
                        + ' — ' + enc(t('non-zero is a bug in writethrough'))
                        : '">' + enc(fmtCount(dirty)) + ' — ' + enc(t('0 by construction in writethrough')))
                    + '</span></div>';
            }
        }
        return '<div style="' + SEC + '">' + enc(t('Read cache')) + '</div>'
            + '<div style="max-width:420px;font-size:12.5px">' + stateHtml + extra
            + '<div style="margin-top:4px">' + rows + '</div></div>';
    }

    // Reconstruct the composer-style band map from live pool state: arrays
    // are the protected bands (boundaries = cumulative heights, bottom-up);
    // any disk capacity above the top array boundary renders as an
    // unprotected pseudo-band (the §2.4 wasted-top-slice picture).
    function poolBands(d) {
        var arrays = ((d && d.arrays) || []).slice();
        if (!arrays.length) {
            return [];
        }
        arrays.sort(function (a, b) { return (a.band || 0) - (b.band || 0); });
        // Partition heights run slightly under the nominal band (1 MiB start,
        // GPT tail) — snap near-GiB heights up so boundaries land on the clean
        // §2.5 grid and rounding slivers never render as phantom bands.
        var GIB = 1073741824;
        var SNAP_SLACK = 64 * 1048576;
        function snapUp(bytes) {
            var rem = bytes % GIB;
            return (rem > 0 && (GIB - rem) <= SNAP_SLACK) ? (bytes - rem + GIB) : bytes;
        }
        var bands = [];
        var start = 0;
        var i;
        var anyNotRunning = false;
        var anyReshaping = false;
        var bandUsable = 0;
        for (i = 0; i < arrays.length; i++) {
            var a = arrays[i];
            var h = snapUp(Number(a.heightBytes) || 0);
            if (arrayNotRunning(a)) {
                // cr3 review follow-up 1: no slots, so no usable figure — the
                // legend reads "not running", never "usable 0 B".
                anyNotRunning = true;
                bands.push({
                    band: a.band,
                    range: { startBytes: start, endBytes: start + h },
                    memberCount: (a.members || []).length,
                    level: a.level,
                    heightBytes: h,
                    usableBytes: null,
                    notRunning: true,
                    'protected': true,
                });
                start += h;
                continue;
            }
            if (a.state === 'reshaping') {
                anyReshaping = true;
            }
            var mc = slotCount(a);   // cr3 M1: slots, not rows (md's own count when sent)
            var usable = h * Math.max(0, mc - (a.level === 'raid6' ? 2 : 1));
            bandUsable += usable;
            bands.push({
                band: a.band,
                range: { startBytes: start, endBytes: start + h },
                memberCount: mc,
                level: a.level,
                heightBytes: h,
                usableBytes: usable,
                'protected': true,
            });
            start += h;
        }
        // cr3 review follow-up 5 (second round): the legend's usable is BAND
        // MATH; the Capacity block's is the LV the filesystem sits on. Growth
        // is NEVER inferred from the difference — md's data offset (256 MiB a
        // slot on members of 128 GiB and more, ahr-geometry.ts) makes band
        // math run over the LV on every healthy pool. Only a structured signal
        // from the daemon says "grown, volume not yet": an array `reshaping`,
        // or an `expansion` intent on the record. (The stranded-capacity fact
        // is a sentence in `advisories` today, not a field; it is not read.)
        // Without a signal, a band figure that differs from the LV at the
        // precision shown says what it is: band capacity before md and volume
        // overhead — so the two never read as one fact disagreeing.
        var lvUsable = knownBytes(d && d.capacity ? d.capacity.usableBytes : null);
        var growPending = !anyNotRunning && (anyReshaping || !!(d && d.expansion));
        var beforeOverhead = !anyNotRunning && !growPending && lvUsable !== null
            && fmtBytes(bandUsable) !== fmtBytes(lvUsable);
        for (i = 0; i < bands.length; i++) {
            if (growPending) {
                bands[i].usableOnceGrown = true;
            } else if (beforeOverhead) {
                bands[i].usableBeforeOverhead = true;
            }
        }
        // The unprotected pseudo-band is band GEOMETRY: capacity that sits
        // above the top array on a disk the bands are cut from. A cache disk
        // is not one of those — it backs no band, its one slice is the whole
        // story, and counting it here manufactures a "wasted" band out of an
        // SSD that is doing exactly what it was attached to do. Spares STAY:
        // a spare is cut to the band geometry and really does carry it.
        var disks = (d && d.disks) || [];
        var tallest = 0;
        var above = 0;
        for (i = 0; i < disks.length; i++) {
            if (disks[i].role === 'cache') {
                continue;
            }
            var s = Number(disks[i].usableBytes) || 0;
            if (s > tallest) {
                tallest = s;
            }
            if (s > start) {
                above++;
            }
        }
        if (tallest > start + SNAP_SLACK && above > 0) {
            bands.push({
                band: arrays.length ? (arrays[arrays.length - 1].band + 1) : 1,
                range: { startBytes: start, endBytes: tallest },
                memberCount: above,
                level: null,
                heightBytes: tallest - start,
                usableBytes: 0,
                'protected': false,
            });
        }
        return bands;
    }

    function bandBarsSection(d) {
        if (!(ANAS.ahr && typeof ANAS.ahr.bandBarsHtml === 'function')) {
            return '';
        }
        // Members and spares only. `diskInBand()` is a pure size test, so a
        // cache SSD as tall as the bands would be painted with band segments
        // it holds not one byte of (ahrcache.1 review).
        var disks = ((d && d.disks) || []).filter(function (x) {
            return x.role !== 'cache';
        }).map(function (x) {
            return { id: x.id, size: Number(x.usableBytes) || 0 };
        });
        var html = ANAS.ahr.bandBarsHtml(poolBands(d), disks);
        return html
            ? ('<div style="' + SEC + '">' + enc(t('Banded layout')) + '</div>' + html)
            : '';
    }

    // ahrcache.1 slice 2 — the read-only aftermath as the detail's state
    // line. The daemon already carries the shared clause in `advisories`
    // (AHR_READONLY_CLAUSE, pushed exactly when the pool is mounted read-only)
    // and the advisories block above renders it — so when the payload has it,
    // this adds NOTHING: one sentence, once, in the daemon's own words. Only
    // a payload that says read-only WITHOUT the advisory gets the short line
    // here; the two never print together.
    function readOnlyLineHtml(d) {
        // cr3: in the `unknown` state the read-only flag is the very thing
        // that could not be read — the unknown line says so; this one never
        // prints beside it, whatever the field says.
        if (d.mountedReadOnly !== true || d.state === 'unknown') {
            return '';
        }
        var adv = d.advisories || [];
        for (var i = 0; i < adv.length; i++) {
            if (adv[i].indexOf('writes are stopped until the pool is remounted') !== -1) {
                return '';
            }
        }
        return '<div style="font-size:12.5px;font-weight:700;color:var(--anas-warn);margin:2px 0 10px">'
            + enc(t('read-only — writes are stopped until the pool is remounted (Remount)'))
            + '</div>';
    }

    // cr3: the `unknown` state on the detail, in the panel's words — what it
    // means for the verbs; the daemon's advisory (rendered below) names the
    // read that failed.
    function unknownStateLineHtml(d) {
        if (d.state !== 'unknown') {
            return '';
        }
        return '<div style="font-size:12.5px;font-weight:700;color:var(--anas-muted);margin:2px 0 10px">'
            + enc(t(STATE_UNKNOWN_REASON)) + '</div>';
    }

    function detailHtml(d) {
        return '<div class="anas-ahr-detail-body" style="padding:12px 14px;color:var(--anas-ink);'
            + 'font:12.5px/1.45 -apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif">'
            + headerHtml(d)
            + unknownStateLineHtml(d)
            + readOnlyLineHtml(d)
            + advisoriesHtml(d)
            + pendingHtml(d)
            + bandBarsSection(d)
            + '<div style="' + SEC + '">' + enc(t('Capacity')) + '</div>'
            + capacityHtml(d)
            + '<div style="' + SEC + '">' + enc(t('Layered stack')) + '</div>'
            + disksHtml(d)
            + arraysHtml(d)
            + lvmHtml(d)
            + cacheHtml(d)
            + fsHtml(d)
            + '</div>';
    }

    // ---- data load ----------------------------------------------------------

    function gridOf(view) {
        return view ? view.down('#ahrGrid') : null;
    }
    function selectedPool(grid) {
        var sel = grid ? grid.getSelection() : null;
        return (sel && sel.length) ? sel[0].get('name') : null;
    }

    // On-demand Details window (the backup-view idiom — the grid owns the full
    // height; vertical space is the scarce axis). Snapshot semantics: fetches
    // on open, the Reload button is the only refresh.
    function loadDetailInto(win, node, name) {
        var panel = win ? win.down('#ahrDetailBody') : null;
        if (!panel || panel.destroyed || panel.destroying) {
            return;
        }
        panel.setHtml('<div style="padding:14px;color:var(--anas-muted);font-size:12.5px">'
            + enc(t('Loading…')) + '</div>');
        ANAS.api.get(node, '/ahr/' + encodeURIComponent(name)).then(function (res) {
            if (!panel || panel.destroyed || panel.destroying) {
                return;
            }
            var d = res && res.data;
            try {
                panel.setHtml(d ? detailHtml(d) : '');
            } catch (e) {
                ANAS.warn('ahr detail render failed: ' + ANAS.errText(e));
            }
        }, function (err) {
            if (panel && !panel.destroyed && !panel.destroying) {
                panel.setHtml('<div style="padding:14px;color:var(--anas-danger);font-size:12.5px">'
                    + enc(t('Failed to load pool detail') + ': ' + ANAS.errText(err)) + '</div>');
            }
        });
    }

    // Change the pool's mountpoint (the ONE mutable pool identity). Prompt
    // prefilled with the current path; the daemon validates (reserved paths,
    // collisions) and confirm-gates the brief unmount. Driven from the grid
    // toolbar (the pools-view idiom — the detail window is display only).
    function changeMountpoint(grid, node) {
        var name = selectedPool(grid);
        if (!name) {
            return;
        }
        ANAS.api.get(node, '/ahr/' + encodeURIComponent(name)).then(function (res) {
            // cr3 M2: prefill only a real mountpoint — an unmounted pool's
            // `mountpoint` is its LV device path, never a place to mount at.
            var d = (res && res.data) || null;
            var current = (poolMounted(d) && d.mountpoint) || '';
            ANAS.changeMountpointFlow({
                node: node,
                resourcePath: '/ahr/' + encodeURIComponent(name),
                label: name,
                current: current,
                view: grid,
                onDone: function () {
                    if (grid && !grid.destroyed && !grid.destroying) {
                        loadPools(grid, node);
                    }
                },
            });
        }, function (err) {
            ANAS.alertMsg('Change mount', ANAS.errText(err));
        });
    }

    // access.2: the SHARED Permissions dialog (14-permissions.js) on the
    // pool's mount — the same window the Datasets view opens, stating the
    // Hybrid RAID differences itself (no acltype step; a recursive apply
    // sweeps the subvolumes under the pool's data, never its snapshots).
    function openPermissions(grid, node) {
        var name = selectedPool(grid);
        if (!name) {
            return;
        }
        if (!ANAS.permissions || typeof ANAS.permissions.open !== 'function') {
            ANAS.warn('the shared Permissions dialog is not loaded');
            return;
        }
        var reload = function () {
            if (grid && !grid.destroyed && !grid.destroying) {
                loadPools(grid, node);
            }
        };
        ANAS.permissions.open({
            node: node,
            accessPath: '/ahr/' + encodeURIComponent(name) + '/access',
            title: name,
            backing: 'ahr',
            onDone: reload,
            onFailed: reload,
        });
    }

    // 11.12: snapshots exist only for the §12 @data/@snapshots subvolume
    // layout. A pre-§12 flat pool has no @snapshots — the verb is disabled
    // with this advisory (there is no in-place migration). ONE wording, shared
    // by every place that gates the button.
    function snapshotsTooltip(subvolLayout) {
        return subvolLayout
            ? t('Manage btrfs snapshots for this pool')
            : t('Snapshots unavailable: this pool predates the @data/@snapshots layout. Destroy and recreate it to gain snapshots (no in-place migration).');
    }

    // The one open on-demand Details window (see openPoolDetailWindow).
    var openDetail = null;

    // ahrcache.1 — grid AND detail reload after every cache job, success AND
    // failure (the §2 reload rule; a failed attach that left the pool
    // uncached and clean must be reflected the moment the modal is dismissed,
    // not at the next manual Reload).
    function reloadAfterCacheJob(grid, node, pool) {
        loadPools(grid, node);
        if (openDetail && openDetail.win && !openDetail.win.destroyed && !openDetail.win.destroying
            && openDetail.name === pool && openDetail.node === node) {
            loadDetailInto(openDetail.win, node, pool);
        }
    }

    function openPoolDetailWindow(node, name) {
        if (!name) {
            return;
        }
        // The Cache block's counters refresh with the detail load (ahrcache.1
        // timeliness), so the toolbar verbs need a handle on the open window
        // to reload it after THEIR jobs — one window at a time is the on-demand
        // idiom here; a closed window clears the slot.
        //
        // ONE window is not a figure of speech: `openDetail` holds a single
        // handle, so a second Details click used to stack a duplicate that
        // `reloadAfterCacheJob` could never reach — an identical-looking window
        // sitting there with the cache counters frozen at the moment it opened,
        // which is exactly the timeliness contract §13 asks the block to keep.
        // Replace the open one instead (its destroy listener clears the slot,
        // so the assignment below must come after the close).
        if (openDetail && openDetail.win && !openDetail.win.destroyed
            && !openDetail.win.destroying) {
            openDetail.win.close();
        }
        openDetail = { win: null, node: node, name: name };
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-ahr-detail',
                title: t('Hybrid RAID pool') + ': ' + enc(name),
                modal: false,
                width: 780,
                height: 540,
                resizable: true,
                layout: 'fit',
                items: [{
                    xtype: 'panel',
                    itemId: 'ahrDetailBody',
                    cls: 'anas-ahr-detail',
                    border: false,
                    scrollable: true,
                    html: '',
                }],
                // Display only — every pool verb lives on the grid toolbar
                // (the Pools-view rule; actions on a pop-up are too hidden).
                buttons: [
                    {
                        text: t('Reload'),
                        cls: 'anas-btn-ahr-detail-reload',
                        iconCls: 'fa fa-refresh',
                        handler: function () { loadDetailInto(win, node, name); },
                    },
                    { text: t('Close'), handler: function () { win.close(); } },
                ],
                listeners: {
                    destroy: function () {
                        if (openDetail && openDetail.win === win) {
                            openDetail = null;
                        }
                    },
                },
            });
            openDetail.win = win;
            win.show();
            loadDetailInto(win, node, name);
        } catch (e) {
            ANAS.warn('ahr detail window failed: ' + ANAS.errText(e));
        }
    }

    // ---- Snapshots (story 11.12, AHR-DESIGN §12) ----------------------------
    //
    // A self-contained manager window over the §12 @data/@snapshots subvolume
    // layout: a grid of snapshots (name, created, read-only) with Create /
    // Delete / Rollback. Mirrors the ZFS snapshot idioms (60-datasets.js).
    //   GET    /ahr/:name/snapshots
    //   POST   /ahr/:name/snapshots {name?}      → 202 job
    //   DELETE /ahr/:name/snapshots/:snap        → 409 confirm → 202 job
    //   POST   /ahr/:name/snapshots/:snap/rollback → 409 confirm → 202 job

    // A UTC-timestamp default name matching the daemon's charset (no colons).
    function defaultSnapshotName() {
        try {
            return new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '');
        } catch (e) {
            return 'snapshot';
        }
    }

    // Design review 2026-09-14, D15: the self-heal repair engine takes its
    // cold read through a transient AHR snapshot named `anas-selfheal-<ts>`
    // (§12 pools put it under @snapshots, where the Snapshots manager lists
    // it). A leftover — the repair's finally failed to delete it — would sit
    // here looking like a snapshot an operator made and remembers nothing
    // about. Rendered as what it is: a transient repair pin, safe to delete
    // when no repair is running — and never a rollback target, because
    // rolling back would swap the served @data out from under a repair's
    // mapping (and it pins one file's subvolume, not the pool).
    var SELFHEAL_PIN_PREFIX = 'anas-selfheal-';
    function isSelfhealPin(name) {
        return (name || '').indexOf(SELFHEAL_PIN_PREFIX) === 0;
    }

    // Format a snapshot's ISO 8601 (local, no timezone) createdAt compactly.
    function fmtSnapCreated(iso) {
        if (!iso) {
            return '—';
        }
        try {
            var d = new Date(iso);
            if (!isNaN(d.getTime())) {
                return Ext.Date.format(d, 'Y-m-d H:i:s');
            }
        } catch (e) {
            // fall through
        }
        // cr3 review follow-up 3: a grid renderer's output is HTML — the
        // unparsed string from the daemon is encoded like every other value.
        return enc('' + iso);
    }

    function openSnapshotManager(node, name) {
        if (!name) {
            return;
        }
        var win = null;

        function grid() {
            return win ? win.down('#ahrSnapGrid') : null;
        }
        function selectedSnap() {
            var g = grid();
            var sel = g ? g.getSelection() : null;
            return (sel && sel.length) ? sel[0].get('name') : null;
        }
        function reload() {
            var g = grid();
            if (!g || g.destroyed || g.destroying) {
                return;
            }
            g.setLoading(true);
            ANAS.api.get(node, '/ahr/' + encodeURIComponent(name) + '/snapshots').then(function (res) {
                if (g.destroyed || g.destroying) {
                    return;
                }
                g.setLoading(false);
                g.getStore().loadData((res && res.data) || []);
                updateSnapButtons();
            }, function (err) {
                if (g.destroyed || g.destroying) {
                    return;
                }
                g.setLoading(false);
                ANAS.alertMsg('Snapshots', t('Failed to load snapshots') + ': ' + ANAS.errText(err));
            });
        }
        function updateSnapButtons() {
            var snap = selectedSnap();
            var has = !!snap;
            var del = win.down('#ahrSnapDelete');
            var rb = win.down('#ahrSnapRollback');
            // Rollback is disabled FOR a transient repair pin (D15) — it is not
            // a pool snapshot an operator can travel to; the reason rides the
            // button's tooltip, never a silent grey-out.
            var pin = !!snap && isSelfhealPin(snap);
            if (del) { del.setDisabled(!has); }
            if (rb) {
                rb.setDisabled(!has || pin);
                try {
                    if (typeof rb.setTooltip === 'function') {
                        rb.setTooltip(pin
                            ? t('a transient ANAS repair pin. There is nothing to roll back to. It is deleted when the repair finishes (safe to delete by hand if no repair is running)')
                            : '');
                    }
                } catch (eT) {
                    // non-fatal
                }
            }
        }

        function createSnap() {
            Ext.Msg.prompt(t('Create snapshot'),
                t('Snapshot name for') + ' <b>' + enc(name) + '</b>:',
                function (btn, value) {
                    if (btn !== 'ok') {
                        return;
                    }
                    var snap = (value || '').replace(/\s+/g, '');
                    if (!snap) {
                        return;
                    }
                    ANAS.runJob({
                        node: node,
                        method: 'post',
                        path: '/ahr/' + encodeURIComponent(name) + '/snapshots',
                        body: { name: snap },
                        view: win,
                        failTitle: 'Create snapshot failed',
                        successMsg: t('Snapshot created') + ': ' + snap,
                        onComplete: reload,
                    });
                }, null, false, defaultSnapshotName());
        }

        function deleteSnap() {
            var snap = selectedSnap();
            if (!snap) {
                return;
            }
            ANAS.confirmAndRun({
                node: node,
                method: 'delete',
                path: '/ahr/' + encodeURIComponent(name) + '/snapshots/' + encodeURIComponent(snap),
                view: win,
                confirmTitle: 'Delete snapshot',
                confirmIntro: t('Deleting snapshot') + ' <b>' + enc(snap) + '</b> '
                    + t('from') + ' <b>' + enc(name) + '</b>:',
                failTitle: 'Delete snapshot failed',
                successMsg: t('Snapshot delete started') + ': ' + snap,
                onSubmitted: reload,
                onComplete: reload,
            });
        }

        function rollbackSnap() {
            var snap = selectedSnap();
            if (!snap) {
                return;
            }
            if (isSelfhealPin(snap)) {
                return; // disabled at the button too — a pin is not a rollback target (D15)
            }
            // Design review 2026-09-14, S8: the last completed scrub's findings
            // are checked for an UNREPAIRED corrupt block inside THIS snapshot
            // (`outsideMount` paths are filesystem-relative, `@snapshots/<name>/…`)
            // — rolling back makes that snapshot the served tree, so the rot
            // rides back in with it. Fail-open: an unreadable job list costs the
            // warning and nothing else.
            ANAS.api.get(node, '/jobs?status=completed').then(function (res) {
                var inside = null;
                try {
                    var list = (res && res.data) || [];
                    var newest = null;
                    for (var i = 0; i < list.length; i++) {
                        var job = list[i] || {};
                        var result = job.result;
                        if (job.operation !== 'ahr.scrub' || job.status !== 'completed' || !result || result.scrubbed !== name) {
                            continue;
                        }
                        var at = Date.parse(job.completedAt || job.startedAt || job.createdAt || '');
                        if (!newest || at >= newest.at) {
                            newest = { at: at, result: result };
                        }
                    }
                    var findings = (newest && newest.result && newest.result.findings) || [];
                    for (var j = 0; j < findings.length; j++) {
                        var f = findings[j] || {};
                        if (f.outsideMount && (f.path || '').indexOf('@snapshots/' + snap + '/') === 0) {
                            inside = f.path;
                            break;
                        }
                    }
                } catch (eF) {
                    inside = null; // non-fatal — the rollback proceeds unwarned
                }
                // The daemon's 409 warnings state the brief unmount and the
                // auto-preserved pre-rollback snapshot (nothing is destroyed).
                ANAS.confirmAndRun({
                    node: node,
                    method: 'post',
                    path: '/ahr/' + encodeURIComponent(name) + '/snapshots/'
                        + encodeURIComponent(snap) + '/rollback',
                    body: {},
                    view: win,
                    confirmTitle: 'Roll back to snapshot',
                    confirmIntro: t('Rolling') + ' <b>' + enc(name) + '</b> '
                        + t('back to snapshot') + ' <b>' + enc(snap) + '</b>:'
                        + (inside
                            ? '<br><br><span style="color:var(--anas-warn,#b06a12);">'
                                + enc(t('the last scrub found an unrepaired corrupt block inside this snapshot (')
                                    + inside + t('); rolling back restores it')) + '</span>'
                            : ''),
                    failTitle: 'Rollback failed',
                    successMsg: t('Rollback started on') + ' ' + name,
                    onSubmitted: reload,
                    onComplete: reload,
                });
            }, function () {
                // Jobs list unreadable: confirm without the warning (fail-open).
                ANAS.confirmAndRun({
                    node: node,
                    method: 'post',
                    path: '/ahr/' + encodeURIComponent(name) + '/snapshots/'
                        + encodeURIComponent(snap) + '/rollback',
                    body: {},
                    view: win,
                    confirmTitle: 'Roll back to snapshot',
                    confirmIntro: t('Rolling') + ' <b>' + enc(name) + '</b> '
                        + t('back to snapshot') + ' <b>' + enc(snap) + '</b>:',
                    failTitle: 'Rollback failed',
                    successMsg: t('Rollback started on') + ' ' + name,
                    onSubmitted: reload,
                    onComplete: reload,
                });
            });
        }

        try {
            var store = Ext.create('Ext.data.Store', {
                fields: ['name', 'createdAt', 'readonly'],
                data: [],
            });
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-ahr-snapshots',
                title: t('Snapshots') + ': ' + enc(name),
                modal: true,
                width: 640,
                height: 460,
                layout: 'fit',
                items: [{
                    xtype: 'grid',
                    itemId: 'ahrSnapGrid',
                    cls: 'anas-grid-ahr-snapshots',
                    store: store,
                    border: false,
                    emptyText: t('No snapshots'),
                    columns: [
                        {
                            text: t('Name'),
                            dataIndex: 'name',
                            flex: 2,
                            renderer: function (v) {
                                // A leftover repair pin is labelled as what it is
                                // (D15) — never silently indistinguishable from an
                                // operator snapshot.
                                if (!isSelfhealPin(v)) {
                                    return enc(v);
                                }
                                return enc(v)
                                    + ' <span style="color:var(--anas-muted,gray);">('
                                    + enc(t('transient ANAS repair pin; safe to delete if no repair is running'))
                                    + ')</span>';
                            },
                        },
                        { text: t('Created'), dataIndex: 'createdAt', flex: 1, renderer: fmtSnapCreated },
                        {
                            text: t('Read-only'),
                            dataIndex: 'readonly',
                            width: 100,
                            renderer: function (v) { return v ? t('yes') : t('no'); },
                        },
                    ],
                    listeners: {
                        selectionchange: function () { updateSnapButtons(); },
                        itemdblclick: function () { rollbackSnap(); },
                    },
                    tbar: ANAS.tbar([
                        {
                            text: t('Create…'),
                            cls: 'anas-btn-ahr-snap-create',
                            iconCls: 'fa fa-plus',
                            handler: createSnap,
                        },
                        {
                            text: t('Delete…'),
                            itemId: 'ahrSnapDelete',
                            cls: 'anas-btn-ahr-snap-delete',
                            iconCls: 'fa fa-trash-o',
                            disabled: true,
                            handler: deleteSnap,
                        },
                        {
                            text: t('Rollback…'),
                            itemId: 'ahrSnapRollback',
                            cls: 'anas-btn-ahr-snap-rollback',
                            iconCls: 'fa fa-history',
                            disabled: true,
                            handler: rollbackSnap,
                        },
                        '->',
                        {
                            text: t('Reload'),
                            iconCls: 'fa fa-refresh',
                            handler: reload,
                        },
                    ]),
                }],
                buttons: [{ text: t('Close'), handler: function () { win.close(); } }],
            });
            win.show();
            reload();
        } catch (e) {
            ANAS.warn('ahr snapshot manager failed: ' + ANAS.errText(e));
        }
    }

    function loadPools(grid, node) {
        if (!grid || grid.destroyed || grid.destroying) {
            return;
        }
        try {
            grid.setLoading(true);
        } catch (e) {
            // non-fatal
        }
        var keep = selectedPool(grid);
        ANAS.api.get(node, '/ahr').then(function (res) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            grid.setLoading(false);
            var rows = (res && res.data) || [];
            grid.getStore().loadData(rows);
            // Restore the previous selection so the detail panel survives reloads.
            if (keep) {
                var rec = grid.getStore().findRecord('name', keep, 0, false, true, true);
                if (rec) {
                    try {
                        grid.getSelectionModel().select(rec, false, true);
                    } catch (eSel) {
                        // non-fatal
                    }
                }
            }
            updateButtons(grid);
        }, function (err) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            grid.setLoading(false);
            ANAS.warn('ahr load failed: ' + ANAS.errText(err));
            try {
                ANAS.alertMsg('Error',
                    t('Failed to load Hybrid RAID pools') + ': ' + ANAS.errText(err));
            } catch (e) {
                // non-fatal
            }
        });
    }

    // ---- Story iscsi.6: "an iSCSI LUN lives on this pool" ------------------
    //
    // The daemon answers once, on the row; the toolbar reads the answer and
    // borrows the daemon's own sentence for the tooltip, so the greyed button
    // and the 409 it would have produced say the same thing. Fail-open at every
    // step — an explanation must never be able to break a toolbar.

    function ahrHeldByLun(rec) {
        try {
            var held = rec && rec.get ? rec.get('heldByLun') : null;
            return (held && held.targetIqn) ? held : null;
        } catch (e) {
            return null;
        }
    }

    function setLunTip(btn, held) {
        try {
            if (!btn || typeof btn.setTooltip !== 'function') {
                return;
            }
            // cr3 L9: the tip is HTML (QuickTip) and `detail` carries a
            // configfs backing path — encoded like every value into HTML.
            btn.setTooltip(held
                ? enc(t('Disabled — this pool is ') + held.detail
                    + t('. Delete the LUN from the iSCSI screen first.'))
                : '');
        } catch (e) {
            // non-fatal
        }
    }

    function updateButtons(grid) {
        var sel = grid.getSelection();
        var has = sel && sel.length > 0;
        // cr3 M3: a running btrfs scrub pass reads `scrubbing` here too, so
        // Scrub (409 "already in flight") and Expand are not offered on it.
        var state = has ? effectivePoolState(sel[0].get('state'), sel[0]) : '';
        // Story iscsi.6: an iSCSI LUN's image file on this pool makes Destroy
        // and Change mount hard 409s at the daemon (no confirm bypass) — a file
        // on the btrfs volume IS the AHR block object, and an unmount pulls it
        // out from under a live target with no error anywhere (GT-40/GT-41).
        // Absent field ⇒ null ⇒ nothing gated (version skew).
        var lunHeld = has ? ahrHeldByLun(sel[0]) : null;
        var LUN_BLOCKED = { destroy: 1, changeMount: 1, unmount: 1 };
        var ids = ['details', 'replace', 'destroy', 'addSpare', 'changeMount'];
        for (var i = 0; i < ids.length; i++) {
            var btn = grid.down('#' + ids[i]);
            if (btn) {
                var lunBlock = !!(lunHeld && LUN_BLOCKED[ids[i]]);
                btn.setDisabled(!has || lunBlock);
                setLunTip(btn, lunBlock ? lunHeld : null);
            }
        }
        // access.2: Permissions acts on the mounted directory — an unmounted
        // pool has none (the daemon 404s it). A LUN's image on the pool does
        // NOT grey it (operator ruling 2026-10-11): a permission change leaves
        // the image's contents alone, and a recursive apply's confirm names
        // the LUN.
        var permBtn = grid.down('#permissions');
        if (permBtn) {
            var mounted = has && sel[0].get('mounted') === true;
            permBtn.setDisabled(!mounted);
            if (typeof permBtn.setTooltip === 'function') {
                permBtn.setTooltip(has && !mounted ? t('The pool is not mounted') : '');
            }
        }
        // 11.12: Snapshots needs the §12 @data/@snapshots layout — a flat pool
        // stays disabled and says why (same wording the detail view carried).
        // cr3: in the `unknown` state the daemon refuses every snapshot verb,
        // and `subvolLayout` reads false only because the mount options could
        // not be read — so the reason is the state, never "predates the layout".
        var snapBtn = grid.down('#snapshots');
        if (snapBtn) {
            var layout = has && !!sel[0].get('subvolLayout');
            var stateUnknown = has && state === 'unknown';
            snapBtn.setDisabled(!layout || stateUnknown);
            snapBtn.setTooltip(!has ? '' : (stateUnknown ? t(STATE_UNKNOWN_REASON) : snapshotsTooltip(layout)));
        }
        // Resume/Abandon only exist for a halted expansion (§6.2) — and while
        // one is halted, a fresh Expand/Replace would 409 anyway, so swap them.
        var exp = has && sel[0].get('expansion');
        var halted = !!(exp && exp.state === 'halted');
        // Expand AND Scrub ONLY on a healthy, idle pool: a degraded/building/
        // rebuilding/expanding/read-only pool (or one mid- or halted-expansion)
        // would 409 at the API (md won't scrub during a build or a recovery) —
        // don't offer a dead button.
        // Resume/Abandon cover the halted case.
        var healthyIdle = has && state === 'healthy' && !halted;
        // cr3: `unknown` is not healthy, so both stay off — and say why.
        var unknownTip = has && state === 'unknown' ? t(STATE_UNKNOWN_REASON) : '';
        var expandBtn = grid.down('#expand');
        if (expandBtn) {
            expandBtn.setDisabled(!healthyIdle);
            if (typeof expandBtn.setTooltip === 'function') {
                expandBtn.setTooltip(unknownTip);
            }
        }
        var scrubBtn = grid.down('#scrub');
        if (scrubBtn) {
            scrubBtn.setDisabled(!healthyIdle);
            if (typeof scrubBtn.setTooltip === 'function') {
                scrubBtn.setTooltip(has && state === 'scrubbing'
                    ? t('A scrub is already running on this pool') : unknownTip);
            }
        }
        var resumeBtn = grid.down('#resumeExpand');
        var abandonBtn = grid.down('#abandonExpand');
        if (resumeBtn) {
            resumeBtn.setHidden(!halted);
        }
        if (abandonBtn) {
            abandonBtn.setHidden(!halted);
        }
        var cache = has ? sel[0].get('cache') : null;
        var cacheBtn = grid.down('#attachCache');
        if (cacheBtn) {
            // ahrcache.1: Attach is live for a pool whose volume is assembled
            // (the route refuses offline/failed — don't offer a dead button)
            // and which has no cache yet. A `cache` field ABSENT (older
            // daemon) leaves the button live — the route 404s there and the
            // dialog says "not available in this build", the file's standing
            // 404 treatment.
            // cr3: the daemon refuses attach in the `unknown` state too.
            var absentish = !cache || cache.state === 'absent';
            var cacheable = has && absentish && state !== 'offline' && state !== 'failed'
                && state !== 'unknown';
            cacheBtn.setDisabled(!cacheable);
            cacheBtn.setTooltip(!has
                ? ''
                : (!absentish
                    ? t('This pool already has a read cache — detach it first')
                    : (state === 'offline' || state === 'failed')
                        ? t('The pool\'s volume is not assembled — there is nothing to cache')
                        : state === 'unknown' ? t(STATE_UNKNOWN_REASON) : ''));
        }
        // Detach is live for TWO shapes (the route's own test): a live cache
        // target in any state, and a leftover <pool>-cache<n> slice on a
        // state-absent pool — the died-and-returned device's mark (§13),
        // which detach is the only product path to delete.
        var detachBtn = grid.down('#detachCache');
        if (detachBtn) {
            var something = !!cache
                && (cache.state !== 'absent' || (cache.devices && cache.devices.length > 0));
            // …but an OFFLINE pool releases a LIVE cache through
            // `lvconvert --uncache`, which needs an active volume, and the
            // route refuses exactly that shape. A mere leftover slice comes
            // off with `sgdisk -d`, which asks nothing of LVM, so it stays
            // detachable on an offline pool — this mirrors the route rather
            // than Attach, or the button would be dead where the recovery
            // lives (detaching a FAILED cache IS the recovery, on a pool the
            // failure has already dragged to degraded).
            var liveOnOffline = something && state === 'offline'
                && cache.state !== 'absent';
            var detachable = has && something && !liveOnOffline;
            detachBtn.setDisabled(!detachable);
            detachBtn.setTooltip(!has
                ? ''
                : (liveOnOffline
                    ? t('The pool\'s volume is not assembled — bring it online first, the cache is released by uncache')
                    : (!detachable ? t('This pool has no read cache to detach') : '')));
        }
        // Remount (ahrcache.1 slice 2): offered only for a selected pool whose
        // record carries `mountedReadOnly === true` — the FIELD, not the state
        // badge (the ladder lets failed/offline outrank readonly, which would
        // hide the verb exactly when it is needed). A daemon that omits the
        // field is an older one — no field, no button. A FAILED cache in front
        // of the volume 409s at the route (detach first), so that shape is
        // disabled with the reason on the button rather than offered.
        var remountBtn = grid.down('#remount');
        if (remountBtn) {
            // cr3: hidden in the `unknown` state whatever the field says —
            // the read-only flag is exactly what could not be read.
            var readOnly = has && sel[0].get('mountedReadOnly') === true && state !== 'unknown';
            var cacheFailed = !!(cache && cache.state === 'failed');
            remountBtn.setHidden(!readOnly);
            remountBtn.setDisabled(!readOnly || cacheFailed);
            remountBtn.setTooltip(readOnly && cacheFailed
                ? t('Detach the failed cache first — the route refuses until then')
                : '');
        }
        // Re-add appears only when a member is faulty/missing (11.9).
        var readdBtn = grid.down('#readd');
        if (readdBtn) {
            readdBtn.setHidden(!has || readdCandidates(sel[0]).length === 0);
        }
        // Remove spare appears only when the pool actually has one (11.11).
        var rmSpareBtn = grid.down('#removeSpare');
        if (rmSpareBtn) {
            rmSpareBtn.setHidden(!has || spareDisks(sel[0]).length === 0);
        }
    }

    // The selected pool's hot-spare disks (11.11 — role fused daemon-side).
    function spareDisks(rec) {
        var out = [];
        var disks = (rec && rec.get('disks')) || [];
        for (var i = 0; i < disks.length; i++) {
            if (disks[i].role === 'spare') {
                out.push(disks[i]);
            }
        }
        return out;
    }

    // Disk ids with a faulty/missing member slot in any band (11.9).
    function readdCandidates(rec) {
        var out = [];
        var seen = {};
        var arrays = (rec && rec.get('arrays')) || [];
        for (var i = 0; i < arrays.length; i++) {
            var members = arrays[i].members || [];
            for (var m = 0; m < members.length; m++) {
                var st = members[m].memberState;
                if ((st === 'faulty' || st === 'missing') && members[m].disk && !seen[members[m].disk]) {
                    seen[members[m].disk] = true;
                    out.push(members[m].disk);
                }
            }
        }
        return out;
    }

    function openReadd(grid, node) {
        var pool = selectedPool(grid);
        var sel = grid.getSelection();
        if (!pool || !sel || !sel.length) {
            return;
        }
        var candidates = readdCandidates(sel[0]);
        function run(diskId) {
            ANAS.confirmAndRun({
                node: node,
                method: 'post',
                path: '/ahr/' + encodeURIComponent(pool) + '/disk/'
                    + encodeURIComponent(diskId) + '/readd',
                body: {},
                view: grid,
                confirmTitle: 'Re-add disk',
                confirmIntro: t('Re-adding') + ' <b>' + enc(diskId) + '</b> '
                    + t('to') + ' <b>' + enc(pool) + '</b>:',
                failTitle: 'Re-add failed',
                successMsg: t('Re-add started on') + ' ' + pool,
                onSubmitted: function () {
                    loadPools(grid, node);
                },
                onComplete: function () {
                    loadPools(grid, node);
                },
            });
        }
        if (candidates.length === 1) {
            run(candidates[0]);
            return;
        }
        // Several faulty members (or a vanished one the daemon knows better
        // than the UI): prompt with the first candidate prefilled, editable.
        Ext.Msg.prompt(t('Re-add disk'), t('Disk id (by-id) to re-add into') + ' <b>' + enc(pool) + '</b>:',
            function (btn, value) {
                if (btn === 'ok' && value) {
                    run(value.replace(/\s+/g, ''));
                }
            }, null, false, candidates[0] || '');
    }

    // 11.11: attach a full-coverage hot spare. Disk picker over the available
    // inventory; the daemon enforces the §11 coverage rule and a too-small
    // disk is refused with the exact shortfall — shown verbatim here.
    function openAddSpare(grid, node) {
        var pool = selectedPool(grid);
        if (!pool) {
            return;
        }
        var win = null;
        var GIB = 1073741824;
        var spareAssigned = {};   // diskId -> 'spare' (single-slot bay)
        var spareDrag = null;     // the shared drag-select controller
        var topBoundary = 0;      // pool's top array boundary (bytes; 0 = unknown)
        var diskById = {};

        function bodyEl() {
            var p = win ? win.down('#ahrSpareBody') : null;
            return (p && p.getEl()) ? p.getEl().dom : null;
        }

        // Client-side §11 coverage HINT (the daemon re-checks authoritatively):
        // usable = floor-to-GiB(raw) must reach the pool's top array boundary.
        // Computed only when the boundary is known; else null → the API refusal
        // (400) is the fallback. Conservative (never a false refusal): the
        // boundary is summed from the arrays' data heights, so it never exceeds
        // the daemon's true boundary.
        function coverageShortfall(diskId) {
            var d = diskById[diskId];
            if (!d || !(topBoundary > 0)) {
                return null;
            }
            var usable = Math.floor((Number(d.size) || 0) / GIB) * GIB;
            if (usable >= topBoundary) {
                return null;
            }
            var shortfall = topBoundary - usable;
            return t('This disk cannot serve as a hot spare: it must cover every band '
                + '(usable ≥ ') + fmtBytes(topBoundary) + t(', the pool\'s top array boundary) '
                + 'but has ') + fmtBytes(usable) + t(' usable after rounding — ')
                + fmtBytes(shortfall) + t(' short. A partial spare is refused (§11).');
        }

        function showRefusal(reason) {
            var root = bodyEl();
            var el = root ? root.querySelector('#ahrsp-refusal') : null;
            if (!el) {
                return;
            }
            if (!reason) {
                el.innerHTML = '';
                return;
            }
            el.innerHTML = '<div style="font-size:12px;padding:8px 10px;border-radius:9px;'
                + 'background:color-mix(in srgb,var(--anas-danger) 14%,transparent);'
                + 'color:var(--anas-danger);display:flex;gap:7px;align-items:flex-start">'
                + '<span>⛔</span><span>' + enc(reason) + '</span></div>';
        }

        function submit() {
            var diskId = spareDrag ? spareDrag.selectedInBay('spare')[0] : null;
            if (!diskId) {
                ANAS.alertMsg('Add hot spare', t('Drag the disk to attach onto the spare bay.'));
                return;
            }
            ANAS.confirmAndRun({
                node: node,
                method: 'post',
                path: '/ahr/' + encodeURIComponent(pool) + '/spare',
                body: { diskId: diskId },
                view: grid,
                confirmTitle: 'Add hot spare',
                confirmIntro: t('Attaching') + ' <b>' + enc(diskId) + '</b> '
                    + t('as a hot spare to') + ' <b>' + enc(pool) + '</b> '
                    + t('wipes the disk:'),
                failTitle: 'Add hot spare failed',
                successMsg: t('Hot spare attach started on') + ' ' + pool,
                onSubmitted: function () {
                    if (win && !win.destroyed && !win.destroying) {
                        win.close();
                    }
                    loadPools(grid, node);
                },
                // A validation refusal (e.g. a too-small spare the client hint
                // didn't catch) surfaces the daemon's exact reason via the fail
                // alert; bounce the staged disk back so another can be tried.
                onFailed: function () {
                    var k;
                    for (k in spareAssigned) {
                        if (spareAssigned.hasOwnProperty(k)) { delete spareAssigned[k]; }
                    }
                    if (spareDrag) { spareDrag.render(); }
                },
                onComplete: function () {
                    loadPools(grid, node);
                },
            });
        }

        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-ahr-spare',
                title: t('Add hot spare') + ': ' + enc(pool),
                modal: true,
                width: 620,
                height: 440,
                layout: 'fit',
                items: [{
                    xtype: 'panel',
                    itemId: 'ahrSpareBody',
                    border: false,
                    scrollable: true,
                    html: '',
                }],
                buttons: [
                    {
                        text: t('Cancel'),
                        handler: function () {
                            win.close();
                        },
                    },
                    {
                        text: t('Add hot spare'),
                        cls: 'anas-btn-ahr-spare-exec',
                        handler: submit,
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('ahr spare window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
        try {
            win.setLoading(true);
        } catch (eL) {
            // non-fatal
        }
        // Render the tray + single spare bay and mount the drag controller.
        function renderSpareForm(avail) {
            var p = win ? win.down('#ahrSpareBody') : null;
            if (!p) {
                return;
            }
            p.setHtml('<div style="padding:12px;font-size:12.5px;color:var(--anas-ink)">'
                + '<div style="color:var(--anas-muted);font-size:11.5px;margin:0 0 8px">'
                + enc(t('Drag a disk onto the spare bay. A hot spare must cover EVERY band: '
                    + 'its usable size must reach the pool\'s top array boundary — a smaller disk '
                    + 'is refused at the drop with the exact shortfall. The disk is wiped and '
                    + 'sliced with the full band geometry; from then on md rebuilds onto it the '
                    + 'moment any member fails, with no operator in the loop.'))
                + '</div>'
                + '<div style="display:flex;gap:12px;align-items:stretch;flex-wrap:wrap">'
                + '<div style="flex:1 1 240px;min-width:0">'
                + '<div style="' + SEC + ';margin:0 0 4px">' + enc(t('Available')) + '</div>'
                + '<div data-anas-zone="tray" style="display:flex;flex-direction:column;min-height:74px;'
                + 'border:1px solid var(--anas-card-edge);border-radius:11px;padding:4px;'
                + 'background:var(--anas-panel)"></div></div>'
                + '<div style="flex:1 1 240px;min-width:0">'
                + '<div style="' + SEC + ';margin:0 0 4px">' + enc(t('Spare bay')) + '</div>'
                + '<div class="anas-gfx-bay anas-grid-ahrsp-bay" data-anas-zone="bay:spare"'
                + ' style="display:flex;flex-wrap:wrap;gap:8px;min-height:74px;border-radius:11px;'
                + 'padding:10px;background:var(--anas-bay);box-shadow:inset 0 2px 6px rgba(0,0,0,.16)">'
                + '</div></div></div>'
                + '<div id="ahrsp-refusal" style="margin-top:10px"></div></div>');
            var root = bodyEl();
            if (!root) {
                return;
            }
            if (ANAS.ahrComposer && typeof ANAS.ahrComposer.makeDragSelect === 'function') {
                spareDrag = ANAS.ahrComposer.makeDragSelect({
                    root: root,
                    disks: avail,
                    assigned: spareAssigned,
                    bays: [{ id: 'spare', single: true }],
                    cardClass: 'anas-ahrsp-disk',
                    removeClass: 'anas-ahrsp-unassign',
                    removeAttr: 'data-ahrsp-unassign',
                    bayEmpty: function () {
                        return '<div style="flex:1;min-width:140px;color:var(--anas-muted);font-size:12px;'
                            + 'text-align:center;padding:14px 8px">' + enc(t('Drag one disk here')) + '</div>';
                    },
                    // §11 coverage: too-small spare refused AT THE DROP.
                    blockDrop: function (diskId) { return coverageShortfall(diskId); },
                    onRefuse: function (reason) { showRefusal(reason); },
                    // A valid drop clears any prior refusal note.
                    onChange: function () { showRefusal(null); },
                });
                spareDrag.render();
            }
        }

        // Load the available disks AND the pool's arrays (the top boundary lets
        // the client refuse a too-small spare at the drop; if it can't be had,
        // the API 400 is the fallback).
        ANAS.api.get(node, '/disks').then(function (res) {
            if (!win || win.destroyed || win.destroying) {
                return;
            }
            var avail = composableDisks((res && res.data) || []);   // cr3 L5
            for (var i = 0; i < avail.length; i++) {
                diskById[avail[i].id] = avail[i];
            }
            ANAS.api.get(node, '/ahr/' + encodeURIComponent(pool)).then(function (res2) {
                if (!win || win.destroyed || win.destroying) {
                    return;
                }
                win.setLoading(false);
                var d = (res2 && res2.data) || {};
                var arrays = d.arrays || [];
                var sum = 0;
                for (var j = 0; j < arrays.length; j++) {
                    sum += Number(arrays[j].heightBytes) || 0;
                }
                topBoundary = sum;
                renderSpareForm(avail);
            }, function () {
                if (!win || win.destroyed || win.destroying) {
                    return;
                }
                // No pool detail → no client hint; the API 400 is the fallback.
                win.setLoading(false);
                topBoundary = 0;
                renderSpareForm(avail);
            });
        }, function (err) {
            if (!win || win.destroyed || win.destroying) {
                return;
            }
            win.setLoading(false);
            try {
                ANAS.alertMsg('Error', t('Failed to load disks') + ': ' + ANAS.errText(err));
            } catch (e) {
                ANAS.warn('ahr spare disk load failed: ' + ANAS.errText(err));
            }
        });
    }

    // 11.11: remove a hot spare (confirm-gated — protection headroom drops).
    function openRemoveSpare(grid, node) {
        var pool = selectedPool(grid);
        var sel = grid.getSelection();
        if (!pool || !sel || !sel.length) {
            return;
        }
        var spares = spareDisks(sel[0]);
        function run(diskId) {
            ANAS.confirmAndRun({
                node: node,
                method: 'del',
                path: '/ahr/' + encodeURIComponent(pool) + '/spare/'
                    + encodeURIComponent(diskId),
                view: grid,
                confirmTitle: 'Remove hot spare',
                confirmIntro: t('Removing hot spare') + ' <b>' + enc(diskId) + '</b> '
                    + t('from') + ' <b>' + enc(pool) + '</b> '
                    + t('drops its protection headroom:'),
                failTitle: 'Remove hot spare failed',
                successMsg: t('Hot spare removal started on') + ' ' + pool,
                onSubmitted: function () {
                    loadPools(grid, node);
                },
                onComplete: function () {
                    loadPools(grid, node);
                },
            });
        }
        if (spares.length === 1) {
            run(spares[0].id);
            return;
        }
        // Multiple spares: prompt with the first prefilled (full by-id shown).
        Ext.Msg.prompt(t('Remove hot spare'), t('Spare disk id (by-id) to remove from') + ' <b>' + enc(pool) + '</b>:',
            function (btn, value) {
                if (btn === 'ok' && value) {
                    run(value.replace(/\s+/g, ''));
                }
            }, null, false, spares.length ? spares[0].id : '');
    }

    // ---- read cache verbs (ahrcache.1 slice 3, AHR-DESIGN §13) --------------
    //
    //   POST   /ahr/:name/cache  {disks[]}  — attach (202 job, NOT confirm-
    //                                        gated: a writethrough cache never
    //                                        holds the only copy of anything)
    //   DELETE /ahr/:name/cache             — detach (202 job; the UI shows a
    //                                        plain confirm naming the trade)
    //
    // The Attach dialog reuses the composable-disk picker (the shared
    // drag-select, 11.14) with SSDs first; a rotating pick earns its one
    // sentence, stated as a fact and never argued further. The daemon owns
    // every refusal (non-composable disk, already cached, offline pool,
    // duplicate) and its 409/400 sentence rides the failure modal verbatim.

    // Attach read cache: pick disks, POST through the job queue. Reloads grid
    // AND the open detail window on success AND failure — a failed attach
    // leaves the pool uncached and clean, and the view must say so at once.
    function openAttachCache(grid, node) {
        var pool = selectedPool(grid);
        if (!pool) {
            return;
        }
        var win = null;
        var cacheAssigned = {};   // diskId -> 'cache' (one multi-slot bay)
        var cacheDrag = null;     // the shared drag-select controller
        var rotById = {};         // diskId -> rotational (drives the one note)

        function bodyEl() {
            var p = win ? win.down('#ahrCacheBody') : null;
            return (p && p.getEl()) ? p.getEl().dom : null;
        }
        function selectedIds() {
            return cacheDrag ? cacheDrag.selectedInBay('cache') : [];
        }

        // The ONE sentence a rotating pick earns (§13, the daemon's advisory
        // wording) — shown while ANY selected disk is rotational, gone the
        // moment the pick is all flash.
        function updateRotNote() {
            var root = bodyEl();
            var el = root ? root.querySelector('#ahrc-rotnote') : null;
            if (!el) {
                return;
            }
            var ids = selectedIds();
            var rotating = 0;
            for (var i = 0; i < ids.length; i++) {
                if (rotById[ids[i]]) {
                    rotating++;
                }
            }
            el.innerHTML = rotating
                ? '<div style="font-size:12px;padding:6px 10px;border-radius:9px;'
                    + 'background:color-mix(in srgb,var(--anas-warn) 13%,transparent);'
                    + 'color:var(--anas-warn)">'
                    + enc(t('a rotating cache adds a seek, not speed')) + '</div>'
                : '';
        }

        function submit() {
            var ids = selectedIds();
            if (!ids.length) {
                ANAS.alertMsg('Attach cache', t('Drag at least one disk into the cache bay.'));
                return;
            }
            ANAS.runJob({
                node: node,
                method: 'post',
                path: '/ahr/' + encodeURIComponent(pool) + '/cache',
                body: { disks: ids },
                view: grid,
                failTitle: 'Attach cache failed',
                successMsg: t('Read cache attach started on') + ' ' + pool,
                onSubmitted: function () {
                    if (win && !win.destroyed && !win.destroying) {
                        win.close();
                    }
                    reloadAfterCacheJob(grid, node, pool);
                },
                onFailed: function () {
                    reloadAfterCacheJob(grid, node, pool);
                },
                onComplete: function () {
                    reloadAfterCacheJob(grid, node, pool);
                },
            });
        }

        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-ahr-cache-attach',
                title: t('Attach read cache') + ': ' + enc(pool),
                modal: true,
                width: 620,
                height: 480,
                layout: 'fit',
                items: [{
                    xtype: 'panel',
                    itemId: 'ahrCacheBody',
                    border: false,
                    scrollable: true,
                    html: '',
                }],
                buttons: [
                    {
                        text: t('Cancel'),
                        handler: function () {
                            win.close();
                        },
                    },
                    {
                        text: t('Attach cache'),
                        cls: 'anas-btn-ahr-cache-attach-exec',
                        handler: submit,
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('ahr cache attach window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
        try {
            win.setLoading(true);
        } catch (eL) {
            // non-fatal
        }

        function renderForm(candidates) {
            var p = win ? win.down('#ahrCacheBody') : null;
            if (!p) {
                return;
            }
            p.setHtml('<div style="padding:12px;font-size:12.5px;color:var(--anas-ink)">'
                // The two-sentence advisory, verbatim in substance (§13): the
                // hotspot fact and the consumable fact, stated once.
                + '<div style="font-size:12px;color:var(--anas-muted);margin:0 0 8px">'
                + enc(t('A read cache pays off on hotspot reads: repeated random reads are '
                    + 'served from flash; sequential streams do not benefit. The SSD is a '
                    + 'consumable — cached blocks are rewritten as the working set rotates.'))
                + '</div>'
                + '<div style="color:var(--anas-muted);font-size:11.5px;margin:0 0 8px">'
                + enc(t('Drag disks into the cache bay. Each cache disk is WIPED '
                    + '(one slice cut per disk); flash is sorted first.'))
                + '</div>'
                + '<div style="display:flex;gap:12px;align-items:stretch;flex-wrap:wrap">'
                + '<div style="flex:1 1 240px;min-width:0">'
                + '<div style="' + SEC + ';margin:0 0 4px">' + enc(t('Available')) + '</div>'
                + '<div data-anas-zone="tray" style="display:flex;flex-direction:column;min-height:74px;'
                + 'border:1px solid var(--anas-card-edge);border-radius:11px;padding:4px;'
                + 'background:var(--anas-panel)"></div></div>'
                + '<div style="flex:1 1 240px;min-width:0">'
                + '<div style="' + SEC + ';margin:0 0 4px">' + enc(t('Cache bay')) + '</div>'
                + '<div class="anas-gfx-bay anas-grid-ahrc-bay" data-anas-zone="bay:cache"'
                + ' style="display:flex;flex-wrap:wrap;gap:8px;min-height:74px;border-radius:11px;'
                + 'padding:10px;background:var(--anas-bay);box-shadow:inset 0 2px 6px rgba(0,0,0,.16)">'
                + '</div></div></div>'
                + '<div id="ahrc-rotnote" style="margin-top:10px"></div></div>');
            var root = bodyEl();
            if (!root) {
                return;
            }
            if (ANAS.ahrComposer && typeof ANAS.ahrComposer.makeDragSelect === 'function') {
                cacheDrag = ANAS.ahrComposer.makeDragSelect({
                    root: root,
                    disks: candidates,
                    assigned: cacheAssigned,
                    bays: [{ id: 'cache' }],
                    cardClass: 'anas-ahrcache-disk',
                    removeClass: 'anas-ahrcache-unassign',
                    removeAttr: 'data-ahrcache-unassign',
                    bayEmpty: function () {
                        return '<div style="flex:1;min-width:140px;color:var(--anas-muted);font-size:12px;'
                            + 'text-align:center;padding:14px 8px">' + enc(t('Drag disks here')) + '</div>';
                    },
                    onChange: updateRotNote,
                });
                cacheDrag.render();
            }
            updateRotNote();
        }

        // Candidates: the available inventory PLUS this pool's own reclaimable
        // cache slices (§13 — a died-and-returned device reads ahr_member
        // because of its leftover <pool>-cache<n> slice, and re-attaching to
        // it is exactly the right move; the route re-wipes the stale label).
        // SSDs first (a rotating cache is legal, just not first in line).
        ANAS.api.get(node, '/disks').then(function (res) {
            if (!win || win.destroyed || win.destroying) {
                return;
            }
            var all = (res && res.data) || [];
            var reclaimable = {};
            var i;
            for (i = 0; i < all.length; i++) {
                rotById[all[i].id] = all[i].rotational === true;
            }
            ANAS.api.get(node, '/ahr/' + encodeURIComponent(pool)).then(function (res2) {
                if (!win || win.destroyed || win.destroying) {
                    return;
                }
                win.setLoading(false);
                var c = (res2 && res2.data && res2.data.cache) || null;
                if (c && c.state === 'absent' && c.devices && c.devices.length) {
                    for (i = 0; i < c.devices.length; i++) {
                        reclaimable[c.devices[i]] = true;
                    }
                }
                // cr3 L5: the route's own test (ahr-cache.ts pickCacheDisks):
                // composable, or the pool's own leftover cache slice.
                var candidates = [];
                for (i = 0; i < all.length; i++) {
                    if (composable(all[i]) || reclaimable[all[i].id] === true) {
                        candidates.push(all[i]);
                    }
                }
                candidates.sort(function (a, b) {
                    return (a.rotational === true ? 1 : 0) - (b.rotational === true ? 1 : 0);
                });
                renderForm(candidates);
            }, function () {
                if (!win || win.destroyed || win.destroying) {
                    return;
                }
                // No pool detail → no reclaimable set; the available list is
                // still offerable (the route re-checks authoritatively).
                win.setLoading(false);
                var fallback = composableDisks(all);   // cr3 L5
                fallback.sort(function (a, b) {
                    return (a.rotational === true ? 1 : 0) - (b.rotational === true ? 1 : 0);
                });
                renderForm(fallback);
            });
        }, function (err) {
            if (!win || win.destroyed || win.destroying) {
                return;
            }
            win.setLoading(false);
            try {
                ANAS.alertMsg('Error', t('Failed to load disks') + ': ' + ANAS.errText(err));
            } catch (e) {
                ANAS.warn('ahr cache disk load failed: ' + ANAS.errText(err));
            }
        });
    }

    // Detach read cache: a PLAIN confirm, then the 202 job.
    //
    // Not confirmAndRun. That helper only ever prompts on the daemon's 409
    // confirm-code challenge, and DELETE /v1/ahr/:pool/cache answers 202 by
    // design (§13: a writethrough cache holds no only copy, so there is
    // nothing for a confirm code to protect). Routed through confirmAndRun the
    // dialog would never open and the SSD would be wiped on the first click,
    // with both confirm texts below dead strings — so this uses the plain
    // Ext.Msg.confirm idiom the codebase gives un-gated destructive verbs
    // (60-datasets.js, 69-snapshots.js, 75-iscsi.js). A 202 verb that consumes
    // a consumable earns a click-through, not a confirm code.
    //
    // The trade is named in the story's own words; a FAILED cache says the
    // truth instead — reads do NOT continue until this runs (GT-19). The wipe
    // clause is conditional: with the device gone there is no SSD to wipe, and
    // promising one back would be a lie the operator can check.
    function openDetachCache(grid, node) {
        var pool = selectedPool(grid);
        var sel = grid.getSelection();
        if (!pool || !sel || !sel.length) {
            return;
        }
        var c = sel[0].get('cache') || {};
        var failed = c.state === 'failed';
        var devs = (c.devices && c.devices.length) ? c.devices.join(', ') : '';
        var msg = failed
            ? t('Detaching the FAILED read cache on') + ' <b>' + enc(pool) + '</b> '
                + t('restores reads — every read currently returns an I/O error until it is detached')
            : t('Detaching the read cache on') + ' <b>' + enc(pool) + '</b> — '
                + t('reads continue from the pool');
        msg += devs
            ? '; ' + t('the SSD is wiped and returns to available') + ':'
                + '<br><b>' + enc(devs) + '</b>'
            : '. ' + t('The cache device is gone — there is no SSD left to wipe.');
        function run() {
            ANAS.runJob({
                node: node,
                method: 'del',
                path: '/ahr/' + encodeURIComponent(pool) + '/cache',
                view: grid,
                failTitle: 'Detach cache failed',
                successMsg: t('Read cache detach started on') + ' ' + pool,
                onSubmitted: function () {
                    reloadAfterCacheJob(grid, node, pool);
                },
                onFailed: function () {
                    reloadAfterCacheJob(grid, node, pool);
                },
                onComplete: function () {
                    reloadAfterCacheJob(grid, node, pool);
                },
            });
        }
        try {
            Ext.Msg.confirm(t('Detach cache'), msg, function (btn) {
                if (btn === 'yes') {
                    run();
                }
            });
        } catch (e) {
            ANAS.warn('ahr cache detach confirm failed: ' + ANAS.errText(e));
        }
    }

    // Remount (ahrcache.1 slice 2, AHR-DESIGN §13): the read-only aftermath
    // the automatic uncache CANNOT fix — a pool that took a WRITE during the
    // failure window is btrfs-forced read-only, `mount -o remount,rw` is
    // refused after an error, and only umount + mount restores writes.
    //
    // Confirm-coded on purpose, unlike the cache verbs: the unmount breaks
    // every open handle on the filesystem — SMB and NFS clients, a backup
    // mid-run, a job reading a file — and the daemon's confirm gate says
    // exactly that. Its 409 warnings (the open-handle sentence, the
    // only-way-back sentence, the diagnose-first sentence) ride the confirm
    // window like every other confirm-gated verb. A FAILED cache is not
    // offered at all — the route 409s until it is detached (the button is
    // disabled with the reason instead). Reloads grid AND the open detail on
    // success AND failure, like the cache verbs (the pool's state changes
    // under both outcomes).
    function openRemount(grid, node) {
        var pool = selectedPool(grid);
        if (!pool) {
            return;
        }
        var sel = grid.getSelection();
        var c = (sel && sel.length) ? (sel[0].get('cache') || {}) : {};
        if (c.state === 'failed') {
            return; // disabled at the button too — the route 409s until the cache is detached
        }
        ANAS.confirmAndRun({
            node: node,
            method: 'post',
            path: '/ahr/' + encodeURIComponent(pool) + '/remount',
            body: {},
            view: grid,
            confirmTitle: 'Remount pool',
            confirmIntro: t('Remounting') + ' <b>' + enc(pool) + '</b> '
                + t('unmounts and mounts its filesystem — open share handles break:'),
            failTitle: 'Remount failed',
            successMsg: t('Remount started on') + ' ' + pool,
            onSubmitted: function () {
                reloadAfterCacheJob(grid, node, pool);
            },
            onFailed: function () {
                reloadAfterCacheJob(grid, node, pool);
            },
            onComplete: function () {
                reloadAfterCacheJob(grid, node, pool);
            },
        });
    }

    function resumeExpansion(grid, node) {
        var pool = selectedPool(grid);
        if (!pool) {
            return;
        }
        // Resume is recompute-and-continue (§5.3), behind a confirm (ident.3):
        // the daemon re-checks every approved disk and names the ones it is
        // about to partition before anything is written.
        ANAS.confirmAndRun({
            node: node,
            method: 'post',
            path: '/ahr/' + encodeURIComponent(pool) + '/expand/resume',
            body: {},
            view: grid,
            confirmTitle: 'Resume expansion',
            confirmIntro: t('Resuming the halted expansion of') + ' <b>' + enc(pool) + '</b> '
                + t('recomputes the plan from the pool as it is now and continues it:'),
            failTitle: 'Resume failed',
            successMsg: t('Expansion resumed on') + ' ' + pool,
            onComplete: function () {
                loadPools(grid, node);
            },
            onFailed: function () {
                loadPools(grid, node);
            },
        });
    }

    function abandonExpansion(grid, node) {
        var pool = selectedPool(grid);
        if (!pool) {
            return;
        }
        ANAS.confirmAndRun({
            node: node,
            method: 'post',
            path: '/ahr/' + encodeURIComponent(pool) + '/expand/abandon',
            body: {},
            view: grid,
            confirmTitle: 'Abandon expansion',
            confirmIntro: t('Abandoning the halted expansion of') + ' <b>' + enc(pool) + '</b> '
                + t('keeps the pool at its current layout — completed growth stays, nothing is rolled back:'),
            failTitle: 'Abandon failed',
            successMsg: t('Expansion abandoned') + ': ' + pool,
            onComplete: function () {
                loadPools(grid, node);
            },
        });
    }

    // Expose for the composer (mirror of ANAS.pools.reload).
    ANAS.ahr = ANAS.ahr || {};
    ANAS.ahr.reload = loadPools;
    ANAS.ahr.isComposableDisk = composable;   // cr3 L5: the composer's tray
    ANAS.ahr.selectedPool = selectedPool;
    // The expansion wizard's plan panel, exposed so the dialog-contracts
    // harness can pin what the Change row says for a positive gain, a
    // zero-gain plan, and an older daemon that reports neither.
    ANAS.ahr.planLiveHtml = function (plan, diskList) {
        return planLiveHtml(plan, diskList);
    };

    // ---- actions ------------------------------------------------------------

    // A parallel build may not serve the AHR mutation routes yet — a 404 gets a
    // clear "not in this build" message instead of a raw HTTP error.
    function apiMissing(err, what) {
        if (err && err.status === 404) {
            try {
                ANAS.alertMsg('Not available',
                    what + ' ' + t('is not available in this build of the ANAS daemon yet.'));
            } catch (e) {
                ANAS.warn(what + ' unavailable (404)');
            }
            return true;
        }
        return false;
    }

    function startScrub(grid, node) {
        var pool = selectedPool(grid);
        if (!pool) {
            return;
        }
        // btrfs scrub then md check, sequenced by the daemon (§4) — plain 202.
        ANAS.api.post(node, '/ahr/' + encodeURIComponent(pool) + '/scrub', {}).then(function (res) {
            var job = res && res.job;
            ANAS.toast(t('Scrub started on') + ' ' + pool);
            if (job && job.id) {
                ANAS.pollJob(node, job.id, {
                    view: grid,
                    failTitle: 'Scrub failed',
                    onComplete: function () {
                        loadPools(grid, node);
                    },
                    // cr.45 review: a scrub that ends failed or lost reloads
                    // the pools grid too — pollJob calls onFailed(null) for
                    // lost when there is no onLost, so one handler covers
                    // both, and the grid reflects the outcome's aftermath
                    // (a pool still mid-scrub reads so on the next pull).
                    onFailed: function () {
                        loadPools(grid, node);
                    },
                });
            } else {
                loadPools(grid, node);
            }
        }, function (err) {
            if (apiMissing(err, t('Scrub'))) {
                return;
            }
            try {
                ANAS.alertMsg('Scrub failed', ANAS.errText(err));
            } catch (e) {
                ANAS.warn('ahr scrub failed: ' + ANAS.errText(err));
            }
        });
    }

    function destroyPool(grid, node) {
        var pool = selectedPool(grid);
        if (!pool) {
            return;
        }
        ANAS.confirmAndRun({
            node: node,
            method: 'del',
            path: '/ahr/' + encodeURIComponent(pool),
            view: grid,
            confirmTitle: 'Destroy Hybrid RAID pool',
            confirmIntro: t('Destroying pool') + ' <b>' + enc(pool) + '</b> '
                + t('erases the arrays, the volume, and ALL data on it:'),
            failTitle: 'Destroy failed',
            successMsg: t('Pool destroyed') + ': ' + pool,
            onComplete: function () {
                loadPools(grid, node);
            },
        });
    }

    // ---- expand / replace windows ------------------------------------------

    // Advisor for the expand wizard — the daemon's plan warnings VERBATIM as
    // amber callouts, the SAME treatment as the create composer's advisor
    // (story 11.16 parallel construction). No warnings → a green "looks good".
    function advisorHtml(warnings) {
        warnings = warnings || [];
        var html = '<div style="' + SEC + '">' + enc(t('Advisor')) + '</div>';
        var i;
        if (!warnings.length) {
            if (ANAS.gfx && typeof ANAS.gfx.callout === 'function') {
                return html + ANAS.gfx.callout(enc(t('Layout looks good — every band is protected.')), { level: 'ok' });
            }
            return html + '<div style="color:var(--anas-ok);font-size:12px">✓ '
                + enc(t('Layout looks good — every band is protected.')) + '</div>';
        }
        for (i = 0; i < warnings.length; i++) {
            if (ANAS.gfx && typeof ANAS.gfx.callout === 'function') {
                html += '<div style="margin-bottom:6px">'
                    + ANAS.gfx.callout(enc(warnings[i]), { level: 'warn' }) + '</div>';
            } else {
                html += '<div style="color:var(--anas-warn);font-size:12px;margin:5px 0">⚠ '
                    + enc(warnings[i]) + '</div>';
            }
        }
        return html;
    }

    // Render a LIVE expansion plan (POST /ahr/:name/expand/plan response) with
    // the SAME surfaces as the create composer (story 11.16): the resulting
    // sliced-layout bars, the labelled capacity readout (plan.after via the
    // shared ANAS.ahr.capacityRowsHtml — incl. the Unprotected (wasted) line),
    // the advisor (warnings verbatim), the uniform ready/warn chip, and the
    // ordered step list. Every field is optional-guarded. `diskList` is the
    // post-expansion disk set for the band bars.
    function planLiveHtml(plan, diskList) {
        var html = '';
        // The resulting layout, drawn with the composer's banded disk bars.
        if (plan && plan.bands && plan.bands.length && diskList && diskList.length
            && ANAS.ahr && typeof ANAS.ahr.bandBarsHtml === 'function') {
            html += '<div style="' + SEC + '">' + enc(t('Resulting layout')) + '</div>'
                + ANAS.ahr.bandBarsHtml(plan.bands, diskList);
        }
        // The capacity readout — plan.after rendered with the create composer's
        // shared rows (Usable / Raw / Redundancy overhead / Unprotected wasted).
        var before = plan && plan.before;
        var after = plan && plan.after;
        if (after && ANAS.ahr && typeof ANAS.ahr.capacityRowsHtml === 'function') {
            html += '<div style="' + SEC + '">' + enc(t('Capacity after (estimated)')) + '</div>'
                + ANAS.ahr.capacityRowsHtml(after);
            // The daemon's own verdict (ahrexpand.1) wins over a local
            // subtraction: `usableGain` is band math on both sides, while
            // after − before compares band math to the LIVE volume and shows
            // a few MiB of "growth" on a plan Execute then refuses with 409.
            // An older daemon omits the field — then the subtraction is all
            // there is, and it stays.
            var hasGain = plan && typeof plan.usableGain === 'number';
            var zg = (plan && plan.zeroGain) || null;
            // cr3: before/after usable can be null (AhrPoolCapacity) — the
            // fallback subtraction runs only on two known figures.
            var canSubtract = !!before && knownBytes(before.usableBytes) !== null
                && knownBytes(after.usableBytes) !== null;
            if (hasGain || canSubtract) {
                var gain = hasGain
                    ? Number(plan.usableGain)
                    : (Number(after.usableBytes) || 0) - (Number(before.usableBytes) || 0);
                html += capRow(t('Change'), (hasGain && gain === 0)
                    ? t('no usable capacity')
                    : (gain >= 0 ? '+~' : '−~') + fmtBytes(Math.abs(gain)), true);
                if (hasGain && gain === 0 && zg && zg.shortfall) {
                    html += '<div style="color:var(--anas-warn);font-size:12px;margin-top:2px">'
                        + enc(zg.shortfall) + '</div>';
                }
            }
            html += '<div style="color:var(--anas-muted);font-size:11px;margin-top:2px">'
                + enc(t('Final sizes land slightly lower once metadata overheads are paid.'))
                + '</div>';
        }
        // Steps.
        var steps = (plan && plan.steps) || [];
        if (steps.length) {
            html += '<div style="' + SEC + '">' + enc(t('Steps')) + '</div><ol style="margin:0;padding-left:20px">';
            for (var i = 0; i < steps.length; i++) {
                var s = steps[i];
                html += '<li style="margin:2px 0;font-size:12px">' + enc((s.kind || '') + ' — ' + (s.target || '')
                    + (s.detail ? ' (' + s.detail + ')' : '')) + '</li>';
            }
            html += '</ol>';
        }
        // Advisor (warnings verbatim) + the uniform ready/warn chip.
        html += advisorHtml((plan && plan.warnings) || []);
        if (ANAS.gfx && ANAS.gfx.warnGate) {
            html += ANAS.gfx.warnGate.chip((plan && plan.warnings) || [], 'Ready to expand.');
        }
        // §6.3 fixed truths, always shown with a plan.
        html += '<div style="color:var(--anas-muted);font-size:11.5px;margin-top:10px">'
            + enc(t('The pool stays online during the reshape, but performance degrades and a '
                + 'reshape can take hours on large arrays and cannot be cancelled cleanly '
                + 'mid-flight. Power loss is survivable (md resumes) — do not pull disks.'))
            + '</div>';
        return html || ('<div style="color:var(--anas-muted)">' + enc(t('No plan returned.')) + '</div>');
    }

    // Checkbox list of available disks (full by-id, model, size — nothing
    // truncated). Returns the HTML; ids are read back via input[name].
    function diskChecklistHtml(disks, inputName, type) {
        if (!disks.length) {
            return '<div style="color:var(--anas-muted);font-size:12px">'
                + enc(t('No available disks found.')) + '</div>';
        }
        var html = '';
        for (var i = 0; i < disks.length; i++) {
            var d = disks[i];
            html += '<label style="display:flex;align-items:center;gap:8px;padding:4px 2px;'
                + 'font-size:12px;cursor:pointer">'
                + '<input type="' + (type || 'checkbox') + '" name="' + enc(inputName)
                + '" value="' + enc(d.id) + '">'
                + '<span style="overflow-wrap:anywhere">' + enc(d.id) + '</span>'
                + '<span style="color:var(--anas-muted);white-space:nowrap">'
                + enc((d.model ? d.model + ' · ' : '') + fmtBytes(d.size)) + '</span></label>';
        }
        return html;
    }

    function checkedValues(root, inputName) {
        var out = [];
        try {
            var els = root.querySelectorAll('input[name="' + inputName + '"]:checked');
            for (var i = 0; i < els.length; i++) {
                out.push(els[i].value);
            }
        } catch (e) {
            // fall through
        }
        return out;
    }

    // cr3 L7: the expand confirm names every disk it wipes, read from the
    // request body it signs (addDisks, or the replace pair's incoming disk) —
    // like the create, spare and resume confirms. ONLY that: the daemon's 409
    // carries the headline ("Expanding AHR pool '<name>' starts an online
    // reshape", or the zero-gain shortfall), which the shared confirm shows
    // under this intro since cr3.core, and its warnings carry the reshape
    // facts (online, hours to days, not cancellable). Saying either again
    // here would put the same sentence in the dialog twice.
    function expandConfirmIntro(pool, body) {
        var b = body || {};
        if (b.replace) {
            return t('Replacing') + ' <b>' + enc(b.replace.oldDiskId) + '</b> ' + t('in') + ' <b>'
                + enc(pool) + '</b> ' + t('with') + ' <b>' + enc(b.replace.newDiskId) + '</b>, '
                + t('which is WIPED:');
        }
        var names = [];
        var add = b.addDisks || [];
        for (var i = 0; i < add.length; i++) {
            names.push('<b>' + enc(add[i]) + '</b>');
        }
        return t('Adding to') + ' <b>' + enc(pool) + '</b>' + (names.length ? ', ' + t('WIPES') + ' '
            + names.join(', ') : '') + ':';
    }

    // Expansion wizard (§6.3): pick add-disks OR a replace pair; the plan
    // recomputes LIVE on every change (story 11.16 — the separate "Compute
    // plan" button is gone, matching the create composer's recalc-on-drop),
    // rendering the same sliced layout + capacity + advisor + chip. Execute
    // then commits through the confirm gate. Degrades cleanly when the daemon
    // lacks the routes (404).
    function openExpand(grid, node) {
        var pool = selectedPool(grid);
        if (!pool) {
            return;
        }
        var win = null;
        var formAvail = [];
        var formMembers = [];
        var addAssigned = {};   // diskId -> 'pool' for the drag add-bay
        var addDrag = null;     // the shared drag-select controller (add step)
        var plan = null;        // last live plan response
        var planBody = null;    // the request body the live plan was computed from
        var planSeq = 0;        // sequence guard — drop stale live responses
        var planTimer = null;   // debounce timer

        function bodyEl() {
            var p = win ? win.down('#ahrExpandBody') : null;
            return (p && p.getEl()) ? p.getEl().dom : null;
        }
        function execBtn() {
            return win ? win.down('#ahrExpandExec') : null;
        }

        // Build the request body from the current selection, or null if it is
        // incomplete. silent=true suppresses popups (the live scheduler path).
        function buildBody(silent) {
            var root = bodyEl();
            if (!root) {
                return null;
            }
            var mode = (checkedValues(root, 'ahrx-mode')[0]) || 'add';
            if (mode === 'add') {
                var add = addDrag ? addDrag.selectedInBay('pool') : [];
                if (!add.length) {
                    if (!silent) {
                        ANAS.alertMsg('Expand', t('Drag at least one disk into the add bay.'));
                    }
                    return null;
                }
                return { addDisks: add };
            }
            var oldId = checkedValues(root, 'ahrx-old')[0];
            var newId = checkedValues(root, 'ahrx-new')[0];
            if (!oldId || !newId) {
                if (!silent) {
                    ANAS.alertMsg('Expand', t('Select the member to replace and its replacement.'));
                }
                return null;
            }
            return { replace: { oldDiskId: oldId, newDiskId: newId } };
        }

        // The post-expansion disk set for the band-bar picture: members ± the
        // selected add/replace disks.
        function planDiskList(body) {
            var diskList = [];
            var byId = {};
            var di;
            for (di = 0; di < formAvail.length; di++) {
                byId[formAvail[di].id] = formAvail[di];
            }
            var oldId = body.replace ? body.replace.oldDiskId : null;
            for (di = 0; di < formMembers.length; di++) {
                if (formMembers[di].id !== oldId) {
                    diskList.push(formMembers[di]);
                }
            }
            var addIds = body.addDisks || (body.replace ? [body.replace.newDiskId] : []);
            for (di = 0; di < addIds.length; di++) {
                if (byId[addIds[di]]) {
                    diskList.push(byId[addIds[di]]);
                }
            }
            return diskList;
        }

        function renderPlan(note) {
            var root = bodyEl();
            var target = root ? root.querySelector('#ahrx-plan') : null;
            if (!target) {
                return;
            }
            if (note) {
                target.innerHTML = '<div style="color:var(--anas-muted);font-size:12px;padding:12px 0;'
                    + 'text-align:center">' + enc(note) + '</div>';
                return;
            }
            if (!plan || !planBody) {
                target.innerHTML = '<div style="color:var(--anas-muted);font-size:12px;padding:12px 0;'
                    + 'text-align:center">'
                    + enc(t('Drop disks (or pick a replacement) to preview the resulting layout.'))
                    + '</div>';
                return;
            }
            target.innerHTML = planLiveHtml(plan, planDiskList(planBody));
        }

        // Debounced live plan — the create composer's schedulePreview/runPreview
        // pattern (250 ms + a sequence guard), fired on every add-drag / replace
        // / mode change instead of a "Compute plan" button.
        function schedulePlan() {
            var exec = execBtn();
            if (exec) {
                exec.setDisabled(true);  // stale until a fresh plan lands
            }
            planBody = null;
            if (planTimer) {
                clearTimeout(planTimer);
            }
            planTimer = setTimeout(runPlan, 250);
        }

        function runPlan() {
            var body = buildBody(true);
            if (!body) {
                plan = null;
                planBody = null;
                renderPlan();
                var exec0 = execBtn();
                if (exec0) {
                    exec0.setDisabled(true);
                }
                return;
            }
            var seq = ++planSeq;
            ANAS.api.post(node, '/ahr/' + encodeURIComponent(pool) + '/expand/plan', body)
                .then(function (res) {
                    if (seq !== planSeq) {
                        return;
                    }
                    if (!win || win.destroyed || win.destroying) {
                        return;
                    }
                    plan = (res && res.data) || null;
                    planBody = plan ? body : null;
                    renderPlan();
                    var exec = execBtn();
                    if (exec) {
                        exec.setDisabled(!plan);
                    }
                }, function (err) {
                    if (seq !== planSeq) {
                        return;
                    }
                    if (!win || win.destroyed || win.destroying) {
                        return;
                    }
                    plan = null;
                    planBody = null;
                    var exec = execBtn();
                    if (exec) {
                        exec.setDisabled(true);
                    }
                    var note = (err && err.status === 404)
                        ? t('Expansion planning is not available in this build of the ANAS daemon yet.')
                        : (t('Preview failed') + ': ' + ANAS.errText(err));
                    renderPlan(note);
                });
        }

        function renderForm(avail, members) {
            formAvail = avail || [];
            formMembers = members || [];
            addAssigned = {};
            plan = null;
            planBody = null;
            var html = '<div style="padding:12px;font-size:12.5px;color:var(--anas-ink)">'
                + '<div style="margin-bottom:8px">'
                + '<label style="margin-right:16px"><input type="radio" name="ahrx-mode" value="add" checked> '
                + enc(t('Add disks')) + '</label>'
                + '<label><input type="radio" name="ahrx-mode" value="replace"> '
                + enc(t('Replace a disk (larger)')) + '</label></div>'
                // Add-disks step: the same drag idiom as the create composer —
                // drag cards from Available into the add bay (§6.1 / 11.14).
                + '<div id="ahrx-add">'
                + '<div style="color:var(--anas-muted);font-size:11.5px;margin:2px 0 8px">'
                + enc(t('Drag disks into the add bay. Each added disk is WIPED. '
                    + 'Drop a card back to Available to remove it.')) + '</div>'
                + '<div style="display:flex;gap:12px;align-items:stretch;flex-wrap:wrap">'
                + '<div style="flex:1 1 240px;min-width:0">'
                + '<div style="' + SEC + ';margin:0 0 4px">' + enc(t('Available')) + '</div>'
                + '<div data-anas-zone="tray" style="display:flex;flex-direction:column;min-height:74px;'
                + 'border:1px solid var(--anas-card-edge);border-radius:11px;padding:4px;'
                + 'background:var(--anas-panel)"></div></div>'
                + '<div style="flex:1 1 240px;min-width:0">'
                + '<div style="' + SEC + ';margin:0 0 4px">' + enc(t('Disks to add')) + '</div>'
                + '<div class="anas-gfx-bay anas-grid-ahrx-bay" data-anas-zone="bay:pool"'
                + ' style="display:flex;flex-wrap:wrap;gap:8px;min-height:74px;border-radius:11px;'
                + 'padding:10px;background:var(--anas-bay);box-shadow:inset 0 2px 6px rgba(0,0,0,.16)">'
                + '</div></div></div></div>'
                + '<div id="ahrx-replace" style="display:none">'
                + '<div style="' + SEC + ';margin-top:2px">' + enc(t('Member to replace')) + '</div>'
                + diskChecklistHtml(members, 'ahrx-old', 'radio')
                + '<div style="' + SEC + '">' + enc(t('Replacement disk')) + '</div>'
                + diskChecklistHtml(avail, 'ahrx-new', 'radio') + '</div>'
                + '<div id="ahrx-plan" style="margin-top:10px"></div>'
                + '</div>';
            var p = win ? win.down('#ahrExpandBody') : null;
            if (p) {
                p.setHtml(html);
            }
            var root = bodyEl();
            if (!root) {
                return;
            }
            // Mount the add-disks drag tray/bay (shared controller, 11.14). Every
            // drop recomputes the plan live (schedulePlan) — no Plan button.
            if (ANAS.ahrComposer && typeof ANAS.ahrComposer.makeDragSelect === 'function') {
                addDrag = ANAS.ahrComposer.makeDragSelect({
                    root: root,
                    disks: avail,
                    assigned: addAssigned,
                    bays: [{ id: 'pool' }],
                    cardClass: 'anas-ahrx-disk',
                    removeClass: 'anas-ahrx-unassign',
                    removeAttr: 'data-ahrx-unassign',
                    bayEmpty: function () {
                        return '<div style="flex:1;min-width:140px;color:var(--anas-muted);font-size:12px;'
                            + 'text-align:center;padding:14px 8px">' + enc(t('Drag disks here')) + '</div>';
                    },
                    onChange: schedulePlan,
                });
                addDrag.render();
            }
            var radios = root.querySelectorAll('input[name="ahrx-mode"]');
            for (var i = 0; i < radios.length; i++) {
                radios[i].addEventListener('change', function () {
                    var mode = (checkedValues(root, 'ahrx-mode')[0]) || 'add';
                    root.querySelector('#ahrx-add').style.display = mode === 'add' ? '' : 'none';
                    root.querySelector('#ahrx-replace').style.display = mode === 'replace' ? '' : 'none';
                    schedulePlan();
                });
            }
            // Replace-mode selection also recomputes live (radio picks).
            var picks = root.querySelectorAll('input[name="ahrx-old"], input[name="ahrx-new"]');
            for (var q = 0; q < picks.length; q++) {
                picks[q].addEventListener('change', schedulePlan);
            }
            renderPlan();
        }

        function execute() {
            if (!planBody) {
                return;
            }
            var opts = {
                node: node,
                method: 'post',
                path: '/ahr/' + encodeURIComponent(pool) + '/expand',
                body: planBody,
                view: grid,
                confirmTitle: 'Expand pool',
                confirmIntro: expandConfirmIntro(pool, planBody),
                failTitle: 'Expand failed',
                successMsg: t('Expansion started on') + ' ' + pool,
                // The reshape runs for hours — close the dialog the moment the
                // daemon accepts the job; the grid's state pill carries it on.
                onSubmitted: function () {
                    if (win && !win.destroyed && !win.destroying) {
                        win.close();
                    }
                    loadPools(grid, node);
                },
                onComplete: function () {
                    loadPools(grid, node);
                },
            };
            // Story 11.16: advisory warnings make the reshape confirm a
            // window whose button reads "Expand anyway". The amber section
            // warnGate.applyToConfirm would prepend is NOT used here: the
            // plan's warnings are the planner's preview warnings, and the
            // daemon's 409 lists those same sentences verbatim
            // (ahr-expand.ts expansionWarnings `...plan.preview.warnings`),
            // so the section printed each one twice (cr3 review follow-up 6b).
            if ((plan && plan.warnings && plan.warnings.length) > 0) {
                opts.confirmWindow = true;
                opts.confirmButtonText = t('Expand anyway');
            }
            ANAS.confirmAndRun(opts);
        }

        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-ahr-expand',
                title: t('Expand Hybrid RAID pool') + ': ' + enc(pool),
                modal: true,
                width: 660,
                height: 620,
                layout: 'fit',
                items: [{
                    xtype: 'panel',
                    itemId: 'ahrExpandBody',
                    border: false,
                    scrollable: true,
                    html: '',
                }],
                buttons: [
                    {
                        text: t('Cancel'),
                        handler: function () {
                            win.close();
                        },
                    },
                    {
                        text: t('Execute expansion'),
                        itemId: 'ahrExpandExec',
                        cls: 'anas-btn-ahr-expand-exec',
                        disabled: true,
                        handler: execute,
                    },
                ],
                listeners: {
                    destroy: function () {
                        if (planTimer) {
                            clearTimeout(planTimer);
                        }
                    },
                },
            });
        } catch (e) {
            ANAS.warn('ahr expand window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
        try {
            win.setLoading(true);
        } catch (eL) {
            // non-fatal
        }
        // Load available disks + the pool's members, then render the form.
        ANAS.api.get(node, '/disks').then(function (res) {
            var avail = composableDisks((res && res.data) || []);   // cr3 L5
            ANAS.api.get(node, '/ahr/' + encodeURIComponent(pool)).then(function (res2) {
                if (!win || win.destroyed || win.destroying) {
                    return;
                }
                win.setLoading(false);
                // cr3 L6: members are the disks serving a band (the route's
                // memberIds) — never a spare or the cache disk, which the
                // replace list would offer and the band picture would paint.
                renderForm(avail, poolMemberDisks((res2 && res2.data) || {}));
            }, function (err2) {
                if (!win || win.destroyed || win.destroying) {
                    return;
                }
                win.setLoading(false);
                renderForm(avail, []);
                ANAS.warn('ahr expand member load failed: ' + ANAS.errText(err2));
            });
        }, function (err) {
            if (!win || win.destroyed || win.destroying) {
                return;
            }
            win.setLoading(false);
            try {
                ANAS.alertMsg('Error', t('Failed to load disks') + ': ' + ANAS.errText(err));
            } catch (e) {
                ANAS.warn('ahr expand disk load failed: ' + ANAS.errText(err));
            }
        });
    }

    // Guided single-disk replace: pick the member and the replacement, then
    // POST /ahr/:name/disk/:id/replace through the confirm gate. Uses
    // `mdadm --replace` semantics daemon-side — redundancy is never dropped.
    function openReplace(grid, node) {
        var pool = selectedPool(grid);
        if (!pool) {
            return;
        }
        var win = null;

        function bodyEl() {
            var p = win ? win.down('#ahrReplaceBody') : null;
            return (p && p.getEl()) ? p.getEl().dom : null;
        }

        function submit() {
            var root = bodyEl();
            if (!root) {
                return;
            }
            var oldId = checkedValues(root, 'ahrr-old')[0];
            var newId = checkedValues(root, 'ahrr-new')[0];
            if (!oldId || !newId) {
                ANAS.alertMsg('Replace disk', t('Select the member to replace and its replacement.'));
                return;
            }
            ANAS.confirmAndRun({
                node: node,
                method: 'post',
                path: '/ahr/' + encodeURIComponent(pool) + '/disk/'
                    + encodeURIComponent(oldId) + '/replace',
                body: { newDiskId: newId },
                view: grid,
                confirmTitle: 'Replace disk',
                confirmIntro: t('Replacing') + ' <b>' + enc(oldId) + '</b> '
                    + t('with') + ' <b>' + enc(newId) + '</b> '
                    + t('copies every band it carries onto the new disk:'),
                failTitle: 'Replace failed',
                successMsg: t('Replacement started on') + ' ' + pool,
                // Close on ACCEPT (202) — the copy runs for a while; the grid
                // state pill and job strip carry it from here.
                onSubmitted: function () {
                    if (win && !win.destroyed && !win.destroying) {
                        win.close();
                    }
                    loadPools(grid, node);
                },
                onComplete: function () {
                    loadPools(grid, node);
                },
            });
        }

        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-ahr-replace',
                title: t('Replace disk') + ': ' + enc(pool),
                modal: true,
                width: 620,
                height: 500,
                layout: 'fit',
                items: [{
                    xtype: 'panel',
                    itemId: 'ahrReplaceBody',
                    border: false,
                    scrollable: true,
                    html: '',
                }],
                buttons: [
                    {
                        text: t('Cancel'),
                        handler: function () {
                            win.close();
                        },
                    },
                    {
                        text: t('Replace'),
                        cls: 'anas-btn-ahr-replace-exec',
                        handler: submit,
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('ahr replace window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
        try {
            win.setLoading(true);
        } catch (eL) {
            // non-fatal
        }
        ANAS.api.get(node, '/ahr/' + encodeURIComponent(pool)).then(function (res) {
            // cr3 L6: the route's members only (no spare, no cache disk).
            var members = poolMemberDisks((res && res.data) || {});
            ANAS.api.get(node, '/disks').then(function (res2) {
                if (!win || win.destroyed || win.destroying) {
                    return;
                }
                win.setLoading(false);
                var avail = composableDisks((res2 && res2.data) || []);   // cr3 L5
                var p = win.down('#ahrReplaceBody');
                if (p) {
                    p.setHtml('<div style="padding:12px;font-size:12.5px;color:var(--anas-ink)">'
                        + '<div style="' + SEC + ';margin-top:2px">' + enc(t('Member to replace')) + '</div>'
                        + diskChecklistHtml(members, 'ahrr-old', 'radio')
                        + '<div style="' + SEC + '">' + enc(t('Replacement disk')) + '</div>'
                        + diskChecklistHtml(avail, 'ahrr-new', 'radio')
                        + '<div style="color:var(--anas-muted);font-size:11.5px;margin-top:10px">'
                        + enc(t('The old disk stays in the array while its bands copy over '
                            + '(mdadm --replace) — redundancy is never voluntarily dropped. '
                            + 'A same-nominal-size replacement always fits (sizes are floored '
                            + 'to a safety reserve).'))
                        + '</div></div>');
                }
            }, function (err2) {
                if (!win || win.destroyed || win.destroying) {
                    return;
                }
                win.setLoading(false);
                try {
                    ANAS.alertMsg('Error', t('Failed to load disks') + ': ' + ANAS.errText(err2));
                } catch (e) {
                    ANAS.warn('ahr replace disk load failed: ' + ANAS.errText(err2));
                }
            });
        }, function (err) {
            if (!win || win.destroyed || win.destroying) {
                return;
            }
            win.setLoading(false);
            if (apiMissing(err, t('Hybrid RAID detail'))) {
                return;
            }
            try {
                ANAS.alertMsg('Error', t('Failed to load pool') + ': ' + ANAS.errText(err));
            } catch (e) {
                ANAS.warn('ahr replace pool load failed: ' + ANAS.errText(err));
            }
        });
    }

    // ---- view ---------------------------------------------------------------

    function ahrView(node) {
        var store = Ext.create('Ext.data.Store', {
            fields: [
                'name', 'ahrType', 'state', 'mountpoint', 'mounted',
                // 11.12 §12 layout flag — gates the Snapshots… button.
                'subvolLayout',
                // Nested structures kept verbatim (auto fields): renderers and
                // the detail panel read them directly.
                'capacity', 'arrays', 'disks', 'advisories', 'vg', 'lv',
                // Live expansion intent (§6.2) — drives Resume/Abandon.
                'expansion',
                // Story iscsi.6: the iSCSI LUN whose image file lives on this
                // pool. AUTO field — absent on old daemons leaves get()
                // undefined and nothing is gated (version-skew ruling).
                'heldByLun',
                // ahrcache.1: the read-cache block. AUTO field — absent on a
                // daemon that predates the story means "cannot tell", and the
                // toolbar gates nothing off it (the routes 404 there anyway).
                'cache',
                // cr3 M3: the btrfs-scrub-running fact. AUTO field — absent
                // or null changes nothing (read through btrfsScrubRunning).
                BTRFS_SCRUB_FIELD,
            ],
            data: [],
            sorters: [{ property: 'name', direction: 'ASC' }],
        });

        return {
            xtype: 'panel',
            itemId: 'ahrView',
            cls: 'anas-view anas-view-ahr',
            layout: { type: 'vbox', align: 'stretch' },
            border: false,
            items: [
                {
                    xtype: 'gridpanel',
                    itemId: 'ahrGrid',
                    cls: 'anas-grid-ahr',
                    flex: 1,
                    border: false,
                    store: store,
                    selModel: { mode: 'SINGLE' },
                    emptyText: t('No Hybrid RAID pools — Create composes one from mixed-size disks.'),
                    columns: [
                        {
                            text: t('Name'),
                            dataIndex: 'name',
                            flex: 1,
                            minWidth: 140,
                            renderer: enc,
                        },
                        {
                            text: t('Fault tolerance'),
                            dataIndex: 'ahrType',
                            width: 220,
                            renderer: function (value) {
                                return enc(tierLabel(value));
                            },
                        },
                        {
                            text: t('State'),
                            dataIndex: 'state',
                            width: 140,
                            renderer: renderGridState,
                        },
                        {
                            text: t('Usable'),
                            dataIndex: 'capacity',
                            width: 190,
                            sortable: false,
                            menuDisabled: true,
                            renderer: renderUsable,
                        },
                        // Used / Free / Capacity at the Pools grid's widths —
                        // the same first-class space breakdown ZFS shows.
                        {
                            text: t('Used'),
                            dataIndex: 'capacity',
                            width: 110,
                            sortable: false,
                            menuDisabled: true,
                            renderer: renderUsed,
                        },
                        {
                            text: t('Free'),
                            dataIndex: 'capacity',
                            width: 110,
                            sortable: false,
                            menuDisabled: true,
                            renderer: renderFree,
                        },
                        {
                            text: t('Capacity'),
                            dataIndex: 'capacity',
                            width: 150,
                            sortable: false,
                            menuDisabled: true,
                            renderer: renderCapacityPct,
                        },
                        // Shared Mount column — the Pools grid's, with the AHR
                        // renderer (cr3 M2: no LV path shown as a mount).
                        ahrMountColumn(),
                        {
                            text: t('Activity'),
                            dataIndex: 'arrays',
                            width: 240,
                            sortable: false,
                            menuDisabled: true,
                            renderer: renderActivity,
                        },
                    ],
                    tbar: ANAS.tbar([
                        {
                            text: t('Reload'),
                            itemId: 'refresh',
                            cls: 'anas-btn-ahr-refresh',
                            iconCls: 'fa fa-refresh',
                            handler: function (btn) {
                                loadPools(btn.up('grid'), node);
                            },
                        },
                        {
                            text: t('Create'),
                            itemId: 'create',
                            cls: 'anas-btn-ahr-create',
                            iconCls: 'fa fa-plus-circle',
                            handler: function (btn) {
                                var grid = btn.up('grid');
                                try {
                                    if (ANAS.ahrComposer && typeof ANAS.ahrComposer.open === 'function') {
                                        ANAS.ahrComposer.open({ node: node, grid: grid });
                                        return;
                                    }
                                    ANAS.alertMsg('Create', t('The Hybrid RAID composer is unavailable.'));
                                } catch (e) {
                                    ANAS.warn('ahr composer open failed: ' + ANAS.errText(e));
                                }
                            },
                        },
                        {
                            text: t('Details'),
                            itemId: 'details',
                            cls: 'anas-btn-ahr-details',
                            iconCls: 'fa fa-info-circle',
                            disabled: true,
                            handler: function (btn) {
                                openPoolDetailWindow(node, selectedPool(btn.up('grid')));
                            },
                        },
                        {
                            text: t('Expand'),
                            itemId: 'expand',
                            cls: 'anas-btn-ahr-expand',
                            iconCls: 'fa fa-arrows-alt',
                            disabled: true,
                            handler: function (btn) {
                                openExpand(btn.up('grid'), node);
                            },
                        },
                        {
                            text: t('Replace disk'),
                            itemId: 'replace',
                            cls: 'anas-btn-ahr-replace',
                            iconCls: 'fa fa-exchange',
                            disabled: true,
                            handler: function (btn) {
                                openReplace(btn.up('grid'), node);
                            },
                        },
                        {
                            text: t('Scrub'),
                            itemId: 'scrub',
                            cls: 'anas-btn-ahr-scrub',
                            iconCls: 'fa fa-check-circle',
                            disabled: true,
                            handler: function (btn) {
                                startScrub(btn.up('grid'), node);
                            },
                        },
                        // ahrcache.1: the read-cache verbs — one feature, the
                        // one menu it owns (§2). Attach needs an assembled,
                        // uncached pool; Detach needs a cache target or a
                        // leftover slice (see updateButtons for the gating).
                        {
                            text: t('Attach cache…'),
                            itemId: 'attachCache',
                            cls: 'anas-btn-ahr-cache-attach',
                            iconCls: 'fa fa-link',
                            disabled: true,
                            handler: function (btn) {
                                openAttachCache(btn.up('grid'), node);
                            },
                        },
                        {
                            text: t('Detach cache'),
                            itemId: 'detachCache',
                            cls: 'anas-btn-ahr-cache-detach',
                            iconCls: 'fa fa-chain-broken',
                            disabled: true,
                            handler: function (btn) {
                                openDetachCache(btn.up('grid'), node);
                            },
                        },
                        // ahrcache.1 slice 2 — the read-only aftermath (§13): a
                        // pool that took a write during the failure window is
                        // btrfs-forced read-only, cleared only by umount +
                        // mount. Hidden unless the selected pool's record
                        // carries `mountedReadOnly === true` (the field, never
                        // the state badge); an older daemon omits the field,
                        // and no field is no verb (gated in updateButtons).
                        {
                            text: t('Remount'),
                            itemId: 'remount',
                            cls: 'anas-btn-ahr-remount',
                            iconCls: 'fa fa-sync',
                            hidden: true,
                            handler: function (btn) {
                                openRemount(btn.up('grid'), node);
                            },
                        },
                        // 11.12: the snapshot manager — a grid verb like every
                        // other pool action. Live only for a §12 subvolume-
                        // layout pool; a flat pool keeps it disabled with the
                        // "snapshots unavailable" advisory.
                        {
                            text: t('Snapshots…'),
                            itemId: 'snapshots',
                            cls: 'anas-btn-ahr-snapshots',
                            iconCls: 'fa fa-camera',
                            disabled: true,
                            handler: function (btn) {
                                openSnapshotManager(node, selectedPool(btn.up('grid')));
                            },
                        },
                        {
                            text: t('Change mount…'),
                            itemId: 'changeMount',
                            cls: 'anas-btn-ahr-change-mount',
                            iconCls: 'fa fa-folder-open-o',
                            disabled: true,
                            handler: function (btn) {
                                changeMountpoint(btn.up('grid'), node);
                            },
                        },
                        // access.2: the shared Permissions dialog on the
                        // pool's mount. Live only while the pool is mounted
                        // (a LUN image on the pool does not grey it).
                        {
                            text: t('Permissions'),
                            itemId: 'permissions',
                            cls: 'anas-btn-ahr-permissions',
                            iconCls: 'fa fa-lock',
                            disabled: true,
                            handler: function (btn) {
                                openPermissions(btn.up('grid'), node);
                            },
                        },
                        {
                            text: t('Destroy'),
                            itemId: 'destroy',
                            cls: 'anas-btn-ahr-destroy',
                            iconCls: 'fa fa-trash-o',
                            disabled: true,
                            handler: function (btn) {
                                destroyPool(btn.up('grid'), node);
                            },
                        },
                        // 11.11: pool-level hot spares — Add always offered
                        // for a selected pool; Remove only when one exists.
                        {
                            text: t('Add spare'),
                            itemId: 'addSpare',
                            cls: 'anas-btn-ahr-add-spare',
                            iconCls: 'fa fa-plus-square-o',
                            disabled: true,
                            handler: function (btn) {
                                openAddSpare(btn.up('grid'), node);
                            },
                        },
                        {
                            text: t('Remove spare'),
                            itemId: 'removeSpare',
                            cls: 'anas-btn-ahr-remove-spare',
                            iconCls: 'fa fa-minus-square-o',
                            hidden: true,
                            handler: function (btn) {
                                openRemoveSpare(btn.up('grid'), node);
                            },
                        },
                        // 11.9: visible only when the selected pool has a
                        // faulty/missing member — the returned-disk verb.
                        {
                            text: t('Re-add disk'),
                            itemId: 'readd',
                            cls: 'anas-btn-ahr-readd',
                            iconCls: 'fa fa-rotate-left',
                            hidden: true,
                            handler: function (btn) {
                                openReadd(btn.up('grid'), node);
                            },
                        },
                        // §6.2: a halted expansion surfaces Resume/Abandon
                        // loudly — hidden unless the selected pool carries a
                        // halted AhrExpansionIntent.
                        {
                            text: t('Resume expansion'),
                            itemId: 'resumeExpand',
                            cls: 'anas-btn-ahr-resume',
                            iconCls: 'fa fa-play-circle',
                            hidden: true,
                            handler: function (btn) {
                                resumeExpansion(btn.up('grid'), node);
                            },
                        },
                        {
                            text: t('Abandon expansion'),
                            itemId: 'abandonExpand',
                            cls: 'anas-btn-ahr-abandon',
                            iconCls: 'fa fa-times-circle',
                            hidden: true,
                            handler: function (btn) {
                                abandonExpansion(btn.up('grid'), node);
                            },
                        },
                    ]),
                    listeners: {
                        selectionchange: function () {
                            updateButtons(this);
                        },
                        // Row double-click = Details (matches the other views).
                        itemdblclick: function (grid, rec) {
                            if (rec) {
                                openPoolDetailWindow(node, rec.get('name'));
                            }
                        },
                    },
                },
            ],
            listeners: {
                afterrender: function (view) {
                    loadPools(gridOf(view), node);
                },
                activate: function (view) {
                    loadPools(gridOf(view), node);
                },
            },
        };
    }

    // ---- View registration -------------------------------------------------

    ANAS.views['ahr'] = {
        itemId: 'anas-ahr',
        text: t('Hybrid RAID'),
        iconCls: 'fa fa-server',
        factory: function (node) {
            try {
                return ahrView(node);
            } catch (e) {
                ANAS.warn('ahr view failed: ' + ANAS.errText(e));
                return ANAS.errorPanel(ANAS.errText(e));
            }
        },
    };
})();
