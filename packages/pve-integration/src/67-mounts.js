/*
 * ANAS — Mounts view (Epic 18: story 18.3 + the UI half of 18.5 + the common
 * CIFS/NFS option tier & human-readable mode display of 18.8).
 *
 * A native ExtJS grid over the mount inventory plus a bottom detail area, and an
 * Add / Edit Remote Share wizard (NFS / CIFS) with a preflight Test, tiered
 * options, CIFS credentials, and a client-side fstab-line preview.
 *
 * Pure management (DESIGN "Mounts"): ANAS writes fstab (surgical round-trip) and
 * calls mount/umount; the kernel + mount.nfs/mount.cifs + systemd's fstab
 * generator do the work. configured = the fstab line, actual = findmnt, health =
 * a guarded probe. PVE-owned mounts (read-only storage.cfg parse) appear tagged
 * hands-off and reject mutations — same pattern as PVE-managed pools in 30-pools.
 *
 * ---------------------------------------------------------------------------
 * DAEMON CONTRACT — the field names this view assumes beyond DESIGN.md's
 * endpoint table. Every read is defensive: aliases tolerated, absent fields
 * degrade to a muted dash.
 *
 *   GET /v1/mounts → { data: Mount[] }, each Mount:
 *     mountpoint  (string, identity)   source (string: 'srv:/exp' | '//srv/shr'
 *     | '/dev/..' | 'UUID=..')         type (string fstype; `fstype` accepted as
 *     an alias)                        state ('ok'|'stale'|'unreachable'|
 *     'unmounted'|'armed')             persistent (bool — has an fstab entry;
 *     `inFstab` accepted)              pveManaged (bool; OR a non-empty
 *     `pveStorages[]` like pools)      remote (bool; derived from type if absent)
 *     size, used (bytes; capacity bar) automount (bool)
 *
 *   GET /v1/mounts/:mountpoint → { data: MountDetail } (mountpoint URL-encoded):
 *     fstabLine (string, verbatim; `fstab` alias)   configuredOptions (string;
 *     `optionsConfigured` alias)                    effectiveOptions (string;
 *     `optionsEffective` alias)                     unit { name, activeState,
 *     subState, loadState, result } (`unitState` alias)   health { state, detail }
 *     (or top-level healthDetail)     capacity { size, used, available, percent }
 *     (or top-level size/used/available/capacity)   credentials { username,
 *     domain, set } (`credentialsSet` bool alias)   automount (bool),
 *     idleTimeout (number)            plus the Mount fields above.
 *
 *   POST /v1/mounts/test → { data: { verdict, detail } }
 *     verdict ('ok'|'unreachable'|'auth-failed'|'not-found'|'protocol-mismatch';
 *     `stage` accepted as an alias)   body: { type, server, remotePath,
 *     credentials?, options? }
 *
 *   POST /v1/mounts → 202 { job }   body (create):
 *     { type:'nfs'|'cifs', server, remotePath, mountpoint, persistent,
 *       automount, options:{ ro, noatime, nosuid, nodev, noexec, netdev,
 *         idleTimeout,                                        (common tier)
 *         vers, hard, timeo, retrans, rsize, wsize, proto, sec, noac,
 *         nconnect, bg, lookupcache, actimeo,                 (NFS tier)
 *         domain, uid, gid, fileMode, dirMode, cache, mfsymlinks, forceuid,
 *         forcegid, noserverino, nobrl, sec, iocharset },     (CIFS tier)
 *       extraOptions (free-text passthrough),
 *       credentials:{ username, password, domain } }         (CIFS; write-only)
 *     nofail is FORCED by the daemon (default mode) — the UI shows it locked-on
 *     and does NOT send it as a choice.
 *   PUT /v1/mounts/:mountpoint → 202 { job }   same body minus `persistent`
 *     (create-time only — the PUT does not act on it) and minus `credentials`
 *     unless the operator typed a new password ("unchanged" otherwise).
 *   DELETE /v1/mounts/:mountpoint → 202/409   (unmount + drop fstab; busy → 409
 *     with confirm code + holding-process warnings).
 *
 *   The pure mount/unmount toggle that does NOT touch fstab uses the pools
 *   action-subresource idiom:
 *     POST /v1/mounts/:mountpoint/state  body { action:'mount'|'unmount' } → 202
 *     (unmount busy → 409 + holding processes).
 * ---------------------------------------------------------------------------
 *
 * Test hooks: view 'anas-view anas-view-mounts'; grid 'anas-grid-mounts'; detail
 * 'anas-mount-detail'; toolbar 'anas-btn-mount-refresh' / 'anas-btn-mount-add' /
 * 'anas-btn-mount-toggle' / 'anas-btn-mount-edit' / 'anas-btn-mount-remove';
 * PVE badge 'anas-mount-pve-badge'; wizard window 'anas-win-mount-edit' with test
 * area 'anas-mount-test', preview 'anas-mount-preview', save 'anas-btn-mount-save'.
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

    // Reload cadence while the view is visible — matches the replication view.
    var POLL_MS = 10000;

    // A mountpoint is an absolute path; keep it strict but permissive of the
    // usual characters. Used to validate the wizard's mountpoint field.
    var MP_RE = /^\/[^\0]*$/;

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

    // The daemon keys a mount by its URL-encoded mountpoint (a single path
    // segment — slashes become %2F). Mirrors the DESIGN "URL-encoded mountpoint".
    function encMp(mountpoint) {
        return encodeURIComponent('' + (mountpoint == null ? '' : mountpoint));
    }

    // Value of a form field by itemId selector; undefined on any failure.
    function valOf(win, sel) {
        try {
            var f = win.down(sel);
            return f ? f.getValue() : undefined;
        } catch (e) {
            return undefined;
        }
    }

    // Access radio → boolean, for the preview and the submit alike. The
    // radiogroup is the only source of truth: a hidden-field mirror is a
    // Text-class field, so a mirrored boolean comes back as the truthy string
    // 'false' and every save reads read-only (issue #26). Compare strings.
    function roOf(win) {
        try {
            var g = win.down('#roGroup');
            var v = g && g.getValue();
            return !!(v && v.roMode === 'ro');
        } catch (e) {
            return false;
        }
    }

    // ---- Field aliasing (defensive: tolerate absent / renamed fields) -------

    function first() {
        for (var i = 0; i < arguments.length; i++) {
            var v = arguments[i];
            if (v !== undefined && v !== null && v !== '') {
                return v;
            }
        }
        return undefined;
    }

    function isArray(v) {
        try {
            return Object.prototype.toString.call(v) === '[object Array]';
        } catch (e) {
            return false;
        }
    }

    // A mount row is PVE-managed when pveManaged is true OR (pools precedent) a
    // non-empty pveStorages[] is present. Fail-open: anything we cannot classify
    // stays ANAS-managed so we never wrongly block a real ANAS mount.
    function isPveManaged(rec) {
        try {
            var get = (rec && typeof rec.get === 'function')
                ? function (k) { return rec.get(k); }
                : function (k) { return rec ? rec[k] : undefined; };
            if (get('pveManaged') === true) {
                return true;
            }
            var ps = get('pveStorages');
            return !!(isArray(ps) && ps.length);
        } catch (e) {
            return false;
        }
    }

    // A mount row is AHR-managed (ANAS Hybrid RAID pool persistence) when the
    // daemon flags ahrManaged — derived from the mdadm.conf ARRAY pins, matched
    // on the LV spec. Hands-off here (same 30-pools pattern as PVE): the pool is
    // managed from the Hybrid RAID view, never the Mounts feature.
    function isAhrManaged(rec) {
        try {
            var get = (rec && typeof rec.get === 'function')
                ? function (k) { return rec.get(k); }
                : function (k) { return rec ? rec[k] : undefined; };
            return get('ahrManaged') === true;
        } catch (e) {
            return false;
        }
    }

    // Remote vs local — prefer an explicit flag, else derive from the fstype.
    function isRemoteType(type) {
        var s = ('' + (type || '')).toLowerCase();
        return s.indexOf('nfs') === 0 || s === 'cifs' || s === 'smb'
            || s === 'smbfs' || s === 'smb3';
    }

    function isRemoteRec(rec) {
        try {
            var r = rec.get('remote');
            if (r === true || r === false) {
                return r;
            }
        } catch (e) {
            // fall through to type derivation
        }
        return isRemoteType(rec && rec.get ? rec.get('type') : '');
    }

    // ---- Small pill / badge builders (mount-state vocabulary) --------------

    // A coloured state pill. Mount states are NOT ZFS states, so gfx.statePill
    // does not apply — build a local pill keyed to the four (+armed) verdicts.
    var STATE_SPEC = {
        ok: { color: 'var(--anas-ok,#1f9c56)', label: 'OK',
            title: 'Mounted and answering.' },
        stale: { color: 'var(--anas-warn,#b06a12)', label: 'Stale',
            title: 'Stale file handle — the server changed the object under an open handle.' },
        unreachable: { color: 'var(--anas-danger,#c23b2c)', label: 'Unreachable',
            title: 'The server is not answering (network gone or server down).' },
        unmounted: { color: 'var(--anas-muted,gray)', label: 'Not mounted',
            title: 'Configured but not present in the mount table.' },
        armed: { color: 'var(--anas-accent,#3468c0)', label: 'Automount (armed)',
            title: 'An automount placeholder — mounts on first access. Not an error.' },
        disabled: { color: 'var(--anas-muted,gray)', label: 'Disabled',
            title: 'Deliberately disabled — the fstab entry is commented with the #ANAS marker. Enable restores it (mounts at next boot or via Mount).' },
    };

    function statePill(state) {
        var key = ('' + (state || '')).toLowerCase();
        var spec = STATE_SPEC[key];
        if (!spec) {
            if (!key) {
                return '<span style="color:gray;">&mdash;</span>';
            }
            spec = { color: 'var(--anas-muted,gray)', label: state, title: '' };
        }
        return '<span class="anas-mount-state anas-mount-state-' + enc(key) + '" title="'
            + enc(t(spec.title)) + '" style="display:inline-block;padding:1px 9px;'
            + 'border-radius:9px;font-size:0.85em;color:' + spec.color + ';'
            + 'background:color-mix(in srgb,' + spec.color + ' 15%,transparent);">'
            + enc(t(spec.label)) + '</span>';
    }

    function tagBadge(text, color, title) {
        return '<span class="anas-mount-tag" title="' + enc(title || '') + '"'
            + ' style="display:inline-block;padding:0 7px;border-radius:8px;margin-left:5px;'
            + 'font-size:0.8em;color:#fff;background:' + color + ';">' + enc(text) + '</span>';
    }

    // ---- Renderers ---------------------------------------------------------

    function renderMountpoint(v, meta, rec) {
        var mp = enc(v);
        try {
            if (isPveManaged(rec)) {
                // The standout hands-off marker (mirrors 30-pools' PVE badge).
                var tip = t('Managed by PVE (storage.cfg) — view only');
                var badge = '';
                try {
                    if (ANAS.gfx && typeof ANAS.gfx.badge === 'function') {
                        badge = ANAS.gfx.badge('PVE', { title: tip }) || '';
                    }
                } catch (eB) {
                    badge = '';
                }
                if (!badge) {
                    badge = '<span class="anas-gfx-badge" title="' + enc(tip) + '">PVE</span>';
                }
                return mp + ' <span class="anas-mount-pve-badge" title="' + enc(tip) + '">'
                    + badge + '</span>';
            }
            if (isAhrManaged(rec)) {
                // Mirror the PVE hands-off marker for AHR pool persistence.
                var atip = t('ANAS Hybrid RAID pool — manage it from the Hybrid RAID view');
                var abadge = '';
                try {
                    if (ANAS.gfx && typeof ANAS.gfx.badge === 'function') {
                        abadge = ANAS.gfx.badge('AHR', { title: atip }) || '';
                    }
                } catch (eA) {
                    abadge = '';
                }
                if (!abadge) {
                    abadge = '<span class="anas-gfx-badge" title="' + enc(atip) + '">AHR</span>';
                }
                return mp + ' <span class="anas-mount-ahr-badge" title="' + enc(atip) + '">'
                    + abadge + '</span>';
            }
            // Local (non-remote, non-PVE, non-AHR) rows are observe-only here —
            // ANAS manages remote shares; local storage is ZFS/Pools territory.
            // Mirror the PVE/AHR hands-off marker so the disabled action buttons
            // have a visible explanation, not just a mute tooltip.
            if (!isRemoteRec(rec)) {
                var ltip = t('Local filesystem — managed under Pools (ZFS), not the Mounts feature');
                var lbadge = '';
                try {
                    if (ANAS.gfx && typeof ANAS.gfx.badge === 'function') {
                        lbadge = ANAS.gfx.badge('LOCAL', { title: ltip }) || '';
                    }
                } catch (eL) {
                    lbadge = '';
                }
                if (!lbadge) {
                    lbadge = '<span class="anas-gfx-badge" title="' + enc(ltip) + '">LOCAL</span>';
                }
                return mp + ' <span class="anas-mount-local-badge" title="' + enc(ltip) + '">'
                    + lbadge + '</span>';
            }
        } catch (e) {
            // fall through to the plain mountpoint
        }
        return mp;
    }

    function renderSource(v, meta, rec) {
        var src = '' + (v == null ? '' : v);
        if (!src) {
            return '<span style="color:gray;">&mdash;</span>';
        }
        // Never truncate an identifier — show it whole, monospace, with a tooltip.
        return '<span title="' + enc(src) + '" style="font-family:monospace;font-size:0.92em;">'
            + enc(src) + '</span>';
    }

    function renderType(v, meta, rec) {
        var type = '' + (v == null ? '' : v);
        if (!type) {
            return '<span style="color:gray;">&mdash;</span>';
        }
        var out = '<span class="anas-mount-type">' + enc(type) + '</span>';
        try {
            if (isRemoteRec(rec)) {
                out += tagBadge(t('remote'), 'var(--anas-series-2,#7a3fb0)', t('Remote filesystem'));
            }
        } catch (e) {
            // non-fatal
        }
        return out;
    }

    function renderState(v, meta, rec) {
        return statePill(v);
    }

    // Capacity → a fullness-coloured gfx bar with a labelled used/total tooltip
    // (numbers get labeled context). Muted dash when size is unknown (remote,
    // unmounted, or a dead server — no synchronous stat here).
    function renderCapacity(v, meta, rec) {
        var size = Number(rec.get('size'));
        var used = Number(rec.get('used'));
        if (isNaN(size) || size <= 0 || isNaN(used) || used < 0) {
            return '<span style="color:gray;" title="'
                + enc(t('Capacity is unknown until the mount answers')) + '">&mdash;</span>';
        }
        var frac = used / size;
        var label = fmtBytes(used) + ' / ' + fmtBytes(size);
        try {
            if (ANAS.gfx && typeof ANAS.gfx.bar === 'function') {
                var html = ANAS.gfx.bar(frac, { title: label });
                if (html) {
                    return '<span title="' + enc(label) + '">' + html + '</span>';
                }
            }
        } catch (e) {
            // fall through to text
        }
        return '<span title="' + enc(label) + '">' + enc(label) + '</span>';
    }

    // fstab persistence — a filled badge when persisted, a muted "session" chip
    // otherwise (a mount-now-only entry that is gone after reboot).
    function renderPersisted(v, meta, rec) {
        var persisted = first(rec.get('persistent'), rec.get('inFstab'));
        if (persisted === true) {
            return '<span class="anas-mount-fstab" title="'
                + enc(t('Persisted — has an /etc/fstab entry')) + '"'
                + ' style="display:inline-block;padding:1px 8px;border-radius:9px;font-size:0.82em;'
                + 'color:var(--anas-ok,#1f9c56);'
                + 'background:color-mix(in srgb,var(--anas-ok,#1f9c56) 15%,transparent);">'
                + enc(t('fstab')) + '</span>';
        }
        if (persisted === false) {
            return '<span title="' + enc(t('Mounted now only — not in fstab, gone after reboot')) + '"'
                + ' style="display:inline-block;padding:1px 8px;border-radius:9px;font-size:0.82em;'
                + 'color:var(--anas-muted,gray);'
                + 'background:color-mix(in srgb,var(--anas-muted,gray) 16%,transparent);">'
                + enc(t('session')) + '</span>';
        }
        return '<span style="color:gray;">&mdash;</span>';
    }

    // ---- Grid load / reload ------------------------------------------------

    function mountsGridOf(view) {
        try {
            return view ? view.down('#mountsGrid') : null;
        } catch (e) {
            return null;
        }
    }

    function selectedMount(grid) {
        var sel = grid ? grid.getSelection() : [];
        return (sel && sel.length) ? sel[0] : null;
    }

    // Normalise a raw mount object into a grid record (tolerate `fstype` alias).
    function mountRow(m) {
        m = m || {};
        return {
            mountpoint: m.mountpoint,
            source: m.source,
            type: first(m.type, m.fstype) || '',
            state: m.state || '',
            persistent: (m.persistent !== undefined ? m.persistent : m.inFstab),
            pveManaged: m.pveManaged === true
                || !!(isArray(m.pveStorages) && m.pveStorages.length),
            pveStorages: m.pveStorages,
            ahrManaged: m.ahrManaged === true,
            remote: (m.remote !== undefined ? m.remote : undefined),
            size: m.size,
            used: m.used,
            automount: !!m.automount,
            raw: m,
        };
    }

    // `quiet` skips the grid loading mask — the timed poll refreshes in place
    // with no visible flash; initial render and manual Reload keep the mask.
    function loadMounts(view, node, quiet) {
        var grid = mountsGridOf(view);
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
        // Remember the selected mountpoint so a poll refresh keeps the selection.
        var priorSel = selectedMount(grid);
        var priorMp = priorSel ? priorSel.get('mountpoint') : null;

        ANAS.api.get(node, '/mounts').then(function (res) {
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
            var list = (res && res.data) || [];
            var rows = [];
            for (var i = 0; i < list.length; i++) {
                rows.push(mountRow(list[i]));
            }
            // loadData clears the store, which fires selectionchange with an
            // EMPTY selection — guard so that transient doesn't blank the
            // detail panel; the re-select below (suppressed) can't refire it.
            grid.anasReloading = true;
            try {
                grid.getStore().loadData(rows);
            } catch (e2) {
                ANAS.warn('mounts grid load failed: ' + ANAS.errText(e2));
            }
            // Re-select the prior row by mountpoint. Restored → refresh the
            // detail QUIETLY (no spinner swap, no flicker) so it tracks state;
            // row gone (deleted elsewhere) → clear the detail for real.
            var restored = false;
            if (priorMp) {
                try {
                    var store = grid.getStore();
                    var idx = store.findExact('mountpoint', priorMp);
                    if (idx >= 0) {
                        grid.getSelectionModel().select(idx, false, true);
                        restored = true;
                    }
                } catch (eSel) {
                    // non-fatal
                }
            }
            grid.anasReloading = false;
            if (priorMp) {
                loadMountDetail(view, node, restored ? priorMp : null, true);
            }
            updateButtons(grid);
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
            ANAS.warn('mounts load failed: ' + ANAS.errText(err));
        });
    }

    ANAS.mounts = ANAS.mounts || {};
    ANAS.mounts.reload = loadMounts;

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
            if (btn && typeof btn.setTooltip === 'function') {
                btn.setTooltip(msg || '');
            }
        } catch (e) {
            // non-fatal
        }
    }

    // Enable/disable selection-dependent actions. PVE-managed rows are hands-off
    // (30-pools pattern), and so are LOCAL filesystems — ANAS mutates remote
    // shares only (operator ruling: local rows are observe-only inventory).
    function updateButtons(grid) {
        var rec = selectedMount(grid);
        var has = !!rec;
        var pve = has && isPveManaged(rec);
        var ahr = has && isAhrManaged(rec);
        var mutable = has && !pve && !ahr && isRemoteRec(rec);

        setDisabled(grid, 'mountToggle', !mutable);
        setDisabled(grid, 'mountEdit', !mutable);
        setDisabled(grid, 'mountRemove', !mutable);

        var tip = pve ? t('Disabled — PVE manages this mount')
            : (ahr ? t('View only — this is an ANAS Hybrid RAID pool; manage it from the Hybrid RAID view')
                : (has && !isRemoteRec(rec)
                    ? t('View only — ANAS manages remote shares; local storage is ZFS territory')
                    : ''));
        btnSetTip(grid, 'mountToggle', tip);
        btnSetTip(grid, 'mountEdit', tip);
        btnSetTip(grid, 'mountRemove', tip);

        // Toggle label/icon: an unmounted row offers Mount; anything mounted
        // (ok/stale/unreachable/armed) offers Unmount.
        try {
            var toggle = grid.down('#mountToggle');
            if (toggle) {
                var state = ('' + (has ? rec.get('state') : '')).toLowerCase();
                var unmounted = state === 'unmounted';
                toggle.setText(unmounted ? t('Mount') : t('Unmount'));
                toggle.setIconCls(unmounted ? 'fa fa-play' : 'fa fa-stop');
            }
        } catch (e) {
            // non-fatal
        }
        // Disable/Enable (the #ANAS fstab marker) — config-level, so only
        // fstab-persisted, non-PVE rows. The button label follows the state.
        var isOff = has && ('' + rec.get('state')).toLowerCase() === 'disabled';
        var persisted = has && first(rec.get('persistent'), rec.get('inFstab')) === true;
        setDisabled(grid, 'mountDisable', !(mutable && persisted));
        btnSetTip(grid, 'mountDisable', (pve || ahr) ? tip
            : (has && !persisted ? t('Only fstab-persisted mounts can be disabled') : ''));
        try {
            var dbtn = grid.down('#mountDisable');
            if (dbtn) {
                dbtn.setText(isOff ? t('Enable') : t('Disable'));
                dbtn.setIconCls(isOff ? 'fa fa-check-circle-o' : 'fa fa-ban');
            }
        } catch (eD) {
            // non-fatal
        }
        if (isOff) {
            // A disabled entry is config-off: enable it before mount/edit.
            setDisabled(grid, 'mountToggle', true);
            btnSetTip(grid, 'mountToggle', t('Enable this mount first'));
            setDisabled(grid, 'mountEdit', true);
            btnSetTip(grid, 'mountEdit', t('Enable this mount first'));
        }
    }

    // ---- Detail area -------------------------------------------------------

    function detailPanelOf(view) {
        try {
            return view ? view.down('#mountDetail') : null;
        } catch (e) {
            return null;
        }
    }

    function kv(label, value) {
        return '<tr><td style="padding:2px 14px 2px 0;color:var(--anas-muted,gray);'
            + 'white-space:nowrap;vertical-align:top;">' + enc(label)
            + '</td><td style="padding:2px 0;">' + value + '</td></tr>';
    }

    function mono(s) {
        return '<span style="font-family:monospace;font-size:0.92em;word-break:break-all;">'
            + enc(s) + '</span>';
    }

    function detailHint() {
        return '<div style="padding:12px 14px;color:var(--anas-muted,gray);">'
            + enc(t('Select a mount to see its fstab line, effective options, unit state and health.'))
            + '</div>';
    }

    // Options string can arrive as an array or a comma string — normalise.
    function optStr(v) {
        if (isArray(v)) {
            return v.join(',');
        }
        return '' + (v == null ? '' : v);
    }

    function capacityRow(d) {
        var cap = d.capacity || {};
        var size = Number(first(cap.size, d.size));
        var used = Number(first(cap.used, d.used));
        var avail = Number(first(cap.available, d.available));
        if (isNaN(size) || size <= 0) {
            return '';
        }
        var parts = [];
        if (!isNaN(used)) {
            parts.push(t('used') + ' ' + fmtBytes(used));
        }
        if (!isNaN(avail)) {
            parts.push(t('free') + ' ' + fmtBytes(avail));
        }
        parts.push(t('total') + ' ' + fmtBytes(size));
        var bar = '';
        if (!isNaN(used) && ANAS.gfx && typeof ANAS.gfx.gauge === 'function') {
            try {
                bar = ANAS.gfx.gauge(used / size,
                    { label: fmtBytes(used) + ' / ' + fmtBytes(size), title: t('Capacity') }) || '';
            } catch (e) {
                bar = '';
            }
        }
        return kv(t('Capacity'), bar || enc(parts.join('  ·  ')));
    }

    function unitRow(d) {
        var u = first(d.unit, d.unitState);
        if (!u || typeof u !== 'object') {
            return '';
        }
        var bits = [];
        if (u.activeState) {
            bits.push(u.activeState + (u.subState ? ' (' + u.subState + ')' : ''));
        }
        if (u.loadState) {
            bits.push(u.loadState);
        }
        if (u.result && u.result !== 'success') {
            bits.push(t('result') + ': ' + u.result);
        }
        if (!bits.length) {
            return '';
        }
        // Supplementary info only — a failed unit on a nofail mount is NOT an
        // error on its own (NOTES SURPRISE A); the state pill above is authority.
        var name = u.name ? ('<span style="color:var(--anas-muted,gray);font-size:0.85em;"> '
            + enc(u.name) + '</span>') : '';
        return kv(t('systemd unit'), enc(bits.join('  ·  ')) + name);
    }

    function credentialsRow(d) {
        var c = d.credentials;
        var set = first(c && c.set, d.credentialsSet);
        if (!c && set === undefined) {
            return '';
        }
        var out = [];
        if (c && c.username) {
            out.push(t('user') + ' ' + enc(c.username));
        }
        if (c && c.domain) {
            out.push(t('domain') + ' ' + enc(c.domain));
        }
        // The API NEVER returns secrets — we only say whether a credentials file
        // is present.
        out.push(set === false
            ? '<span style="color:var(--anas-warn,#b06a12);">' + enc(t('no credentials set')) + '</span>'
            : '<span style="color:var(--anas-ok,#1f9c56);">' + enc(t('credentials set')) + '</span>');
        return kv(t('CIFS credentials'), out.join('  ·  '));
    }

    function detailHtml(d) {
        if (!d) {
            return '<div style="padding:12px 14px;color:var(--anas-danger,#c23b2c);">'
                + enc(t('No detail returned for this mount.')) + '</div>';
        }
        var configured = optStr(first(d.configuredOptions, d.optionsConfigured));
        var effective = optStr(first(d.effectiveOptions, d.optionsEffective));
        var fstab = first(d.fstabLine, d.fstab);
        var health = d.health || {};
        var healthDetail = first(health.detail, d.healthDetail);

        var rows = ''
            + kv(t('Mountpoint'), mono(d.mountpoint))
            + kv(t('Source'), mono(d.source))
            + kv(t('Type'), enc(first(d.type, d.fstype) || ''))
            + kv(t('State'), statePill(d.state) + (healthDetail
                ? ' <span style="color:var(--anas-muted,gray);font-size:0.9em;">'
                    + enc(healthDetail) + '</span>' : ''));
        var capRow = capacityRow(d);
        if (capRow) {
            rows += capRow;
        }
        if (configured) {
            rows += kv(t('Configured options'), mono(configured));
        }
        if (effective && effective !== configured) {
            rows += kv(t('Effective options'), mono(effective));
        }
        var uRow = unitRow(d);
        if (uRow) {
            rows += uRow;
        }
        var cRow = credentialsRow(d);
        if (cRow) {
            rows += cRow;
        }

        var html = '<div style="padding:10px 14px;">'
            + '<table style="border-collapse:collapse;width:100%;">' + rows + '</table>';

        // The fstab line, verbatim — config-is-the-API transparency (Principle 13).
        if (fstab) {
            html += '<div style="margin-top:10px;">'
                + '<div style="color:var(--anas-muted,gray);font-size:0.85em;margin-bottom:3px;">'
                + enc(t('/etc/fstab line (as written)')) + '</div>'
                + '<pre style="margin:0;padding:8px 10px;border-radius:6px;overflow-x:auto;'
                + 'background:rgba(127,127,127,0.10);font-size:12px;white-space:pre;">'
                + enc(fstab) + '</pre></div>';
        } else if (first(d.persistent, d.inFstab) === false) {
            html += '<div style="margin-top:10px;color:var(--anas-muted,gray);font-size:0.9em;">'
                + enc(t('Not persisted — this mount has no /etc/fstab entry.')) + '</div>';
        }

        // Advisory warnings (e.g. inline plaintext credentials → migrate on save).
        // Guide-don't-warn: surfaced here, never blocking.
        if (d.warnings && d.warnings.length) {
            var wHtml = '';
            for (var wi = 0; wi < d.warnings.length; wi++) {
                wHtml += '<div style="color:var(--anas-warn,#b06a12);font-size:0.9em;margin-top:4px;">'
                    + '<i class="fa fa-exclamation-triangle" style="margin-right:6px;"></i>'
                    + enc(d.warnings[wi]) + '</div>';
            }
            html += '<div style="margin-top:10px;">' + wHtml + '</div>';
        }
        html += '</div>';
        return html;
    }

    // `quiet` skips the spinner swap — used by the poll refresh, which updates
    // the already-rendered detail in place instead of flickering it.
    function loadMountDetail(view, node, mountpoint, quiet) {
        var panel = detailPanelOf(view);
        if (!panel) {
            return;
        }
        if (!mountpoint) {
            panel.update(detailHint());
            return;
        }
        if (!quiet) {
            panel.update('<div style="padding:12px 14px;color:var(--anas-muted,gray);">'
                + '<i class="fa fa-refresh fa-spin" style="margin-right:6px;"></i>'
                + enc(t('loading…')) + '</div>');
        }
        ANAS.api.get(node, '/mounts/' + encMp(mountpoint)).then(function (res) {
            if (panel.destroyed || panel.destroying) {
                return;
            }
            try {
                panel.update(detailHtml(res && res.data));
            } catch (e) {
                ANAS.warn('mount detail render failed: ' + ANAS.errText(e));
            }
        }, function (err) {
            if (panel.destroyed || panel.destroying) {
                return;
            }
            ANAS.warn('mount detail load failed: ' + ANAS.errText(err));
            panel.update('<div style="padding:12px 14px;color:var(--anas-danger,#c23b2c);">'
                + enc(t('Failed to load detail') + ': ' + ANAS.errText(err)) + '</div>');
        });
    }

    // ---- Mount / Unmount toggle (state action, no fstab change) ------------

    function mountToggle(view, node, rec) {
        if (!rec) {
            return;
        }
        var mp = rec.get('mountpoint');
        var state = ('' + rec.get('state')).toLowerCase();
        var mounting = state === 'unmounted';
        var action = mounting ? 'mount' : 'unmount';
        var grid = mountsGridOf(view);
        var opts = {
            node: node,
            method: 'post',
            path: '/mounts/' + encMp(mp) + '/state',
            body: { action: action },
            view: grid,
            failTitle: mounting ? 'Mount failed' : 'Unmount failed',
            successMsg: (mounting ? t('Mounted') : t('Unmounted')) + ' ' + mp,
            onComplete: function () {
                loadMounts(view, node);
                loadMountDetail(view, node, mp);
            },
        };
        if (mounting) {
            // A plain mount is a safe op — no confirm gate.
            ANAS.runJob(opts);
        } else {
            // Unmount of a busy mount → 409 with the holding-process list; the
            // standard confirm dialog surfaces those warnings before force/lazy.
            opts.confirmTitle = 'Unmount busy filesystem';
            opts.confirmIntro = t('Processes are using this mount:');
            ANAS.confirmAndRun(opts);
        }
    }

    // ---- Disable / Enable (the #ANAS fstab marker; config-level) -----------
    //
    // disable = unmount now (busy → the standard 409 holder-list confirm) and
    // comment the fstab line as '#ANAS <original>'; credentials are kept.
    // enable = strip the marker ONLY (byte-identical restore) — it does not
    // mount; the row shows 'unmounted' until Mount or the next boot.

    function mountEnableDisable(view, node, rec) {
        if (!rec) {
            return;
        }
        var mp = rec.get('mountpoint');
        var disabling = ('' + rec.get('state')).toLowerCase() !== 'disabled';
        var grid = mountsGridOf(view);
        var opts = {
            node: node,
            method: 'post',
            path: '/mounts/' + encMp(mp) + '/state',
            body: { action: disabling ? 'disable' : 'enable' },
            view: grid,
            failTitle: disabling ? 'Disable failed' : 'Enable failed',
            successMsg: (disabling ? t('Disabled') : t('Enabled')) + ' ' + mp,
            onComplete: function () {
                loadMounts(view, node);
                loadMountDetail(view, node, mp);
            },
        };
        if (disabling) {
            opts.confirmTitle = 'Disable mount';
            opts.confirmIntro = t('Processes are using this mount:');
            ANAS.confirmAndRun(opts);
        } else {
            ANAS.runJob(opts);
        }
    }

    // ---- Remove (unmount + drop the fstab entry) ---------------------------

    function removeMount(view, node, rec) {
        if (!rec) {
            return;
        }
        var mp = rec.get('mountpoint');
        var persisted = first(rec.get('persistent'), rec.get('inFstab')) === true;
        var intro = persisted
            ? t('Unmount and remove the /etc/fstab entry for')
            : t('Unmount');
        try {
            Ext.Msg.confirm(t('Remove Mount'), intro + ' "' + enc(mp) + '"?',
                function (btn) {
                    if (btn !== 'yes') {
                        return;
                    }
                    var grid = mountsGridOf(view);
                    // Busy → 409 with holding processes; confirmAndRun surfaces
                    // them and resends with the confirm code (force/lazy behind
                    // the gate, daemon-side).
                    ANAS.confirmAndRun({
                        node: node,
                        method: 'del',
                        path: '/mounts/' + encMp(mp),
                        view: grid,
                        confirmTitle: 'Remove busy mount',
                        confirmIntro: t('Processes are using this mount:'),
                        failTitle: 'Remove failed',
                        successMsg: t('Removed') + ' ' + mp,
                        onComplete: function () {
                            loadMounts(view, node);
                            loadMountDetail(view, node, null);
                        },
                    });
                });
        } catch (e) {
            ANAS.warn('mount remove confirm failed: ' + ANAS.errText(e));
        }
    }

    // ======================================================================
    //  Add / Edit Remote Share wizard — 'anas-win-mount-edit'
    // ======================================================================

    // CIFS SMB dialect options; 1.0 is behind a loud warning (insecure/legacy).
    var CIFS_VERS = ['3.1.1', '3.0', '2.1', '2.0', '1.0'];
    var NFS_VERS = ['4.2', '4.1', '4.0', '3'];

    // Curated common-tier enum stores (mount.cifs(8) / nfs(5)); a leading blank
    // means "unset" (server / kernel default) — the daemon owns the true default.
    // [value, label] pairs; the free-text passthrough box carries the long tail.
    var NFS_PROTO = [['', t('(default — tcp)')], ['tcp', 'tcp'], ['udp', 'udp'], ['rdma', 'rdma']];
    var NFS_SEC = [['', t('(default — sys)')], ['sys', 'sys'], ['krb5', 'krb5'],
        ['krb5i', 'krb5i'], ['krb5p', 'krb5p'], ['none', 'none']];
    var NFS_LOOKUPCACHE = [['', t('(default — all)')], ['all', 'all'], ['none', 'none'],
        ['pos', 'pos'], ['positive', 'positive']];
    var CIFS_CACHE = [['', t('(default — strict)')], ['strict', 'strict'],
        ['loose', 'loose'], ['none', 'none']];
    var CIFS_SEC = [['', t('(default)')], ['ntlmssp', 'ntlmssp'], ['ntlmv2', 'ntlmv2'],
        ['ntlmv2i', 'ntlmv2i'], ['ntlm', 'ntlm'], ['ntlmi', 'ntlmi'], ['krb5', 'krb5'],
        ['krb5i', 'krb5i'], ['ntlmsspi', 'ntlmsspi'], ['none', 'none']];

    // Live octal→human helper (single source of truth in 00-core). Returns an
    // HTML fragment for the small hint under a mode field; empty when blank so an
    // untouched field shows nothing, a red hint when the octal is malformed.
    function modeHintHtml(octal) {
        var s = ('' + (octal == null ? '' : octal)).trim();
        if (!s) {
            return '';
        }
        var m = (ANAS.fmtMode ? ANAS.fmtMode(s) : { valid: false });
        if (!m.valid) {
            return '<span style="color:var(--anas-danger,#c23b2c);">'
                + '<i class="fa fa-exclamation-triangle" style="margin-right:5px;"></i>'
                + enc(t('not a valid octal mode (e.g. 0644)')) + '</span>';
        }
        return '<span style="font-family:monospace;">' + enc(m.symbolic) + '</span>'
            + '<span style="color:var(--anas-muted,gray);"> &middot; ' + enc(m.plain) + '</span>';
    }

    // Update the human-readable hint next to a mode field (itemId → hint itemId).
    function refreshModeHint(win, fieldSel, hintSel) {
        try {
            var hint = win.down(hintSel);
            if (hint) {
                hint.update(modeHintHtml(valOf(win, fieldSel)));
            }
        } catch (e) {
            // non-fatal
        }
    }

    // ---- Identity pickers (owner/group for CIFS uid/gid) -------------------
    //
    // CIFS has no Unix ownership of its own, so uid/gid are mount options mapping
    // to an owner/group. Load the Epic 8 identity lists the way shares/users do.

    function loadOwnerOptions(node, store) {
        ANAS.api.get(node, '/identity/users').then(function (res) {
            if (!store || store.destroyed) {
                return;
            }
            var rows = (res && res.data) || [];
            var data = [];
            for (var i = 0; i < rows.length; i++) {
                var u = rows[i] || {};
                if (u.uid === undefined || u.uid === null) {
                    continue;
                }
                data.push({ id: u.uid, label: u.name + ' (' + u.uid + ')' });
            }
            store.loadData(data);
        }, function (err) {
            ANAS.warn('mount owner list load failed: ' + ANAS.errText(err));
        });
    }

    function loadGroupOptions(node, store) {
        ANAS.api.get(node, '/identity/groups').then(function (res) {
            if (!store || store.destroyed) {
                return;
            }
            var rows = (res && res.data) || [];
            var data = [];
            for (var i = 0; i < rows.length; i++) {
                var g = rows[i] || {};
                if (g.gid === undefined || g.gid === null) {
                    continue;
                }
                data.push({ id: g.gid, label: g.name + ' (' + g.gid + ')' });
            }
            store.loadData(data);
        }, function (err) {
            ANAS.warn('mount group list load failed: ' + ANAS.errText(err));
        });
    }

    // ---- fstab-line preview (best-effort, client-side; daemon authoritative) --

    // Suggest /mnt/<server>-<share>: sanitise to safe path characters.
    function suggestMountpoint(server, remotePath) {
        var s = ('' + (server || '')).replace(/[^A-Za-z0-9._-]+/g, '');
        var seg = ('' + (remotePath || '')).replace(/^[\/\\]+|[\/\\]+$/g, '');
        var last = seg.split(/[\/\\]/).pop() || '';
        last = last.replace(/[^A-Za-z0-9._-]+/g, '');
        var name = [s, last].filter(function (x) { return !!x; }).join('-');
        return name ? ('/mnt/' + name) : '';
    }

    // Assemble the option list the way the daemon would (known tier + passthrough).
    // nofail is FORCED and shown first; this is a preview only.
    function buildOptionList(win, type) {
        var opts = [];
        if (roOf(win)) {
            opts.push('ro');
        } else {
            opts.push('rw');
        }
        opts.push('nofail'); // forced — an absent server never blocks boot
        // Remote default hardening (DESIGN: nosuid,nodev default-on for remote).
        if (valOf(win, '#optNosuid')) {
            opts.push('nosuid');
        }
        if (valOf(win, '#optNodev')) {
            opts.push('nodev');
        }
        if (valOf(win, '#optNoexec')) {
            opts.push('noexec');
        }
        if (valOf(win, '#optNoatime')) {
            opts.push('noatime');
        }
        if (valOf(win, '#optNetdev')) {
            opts.push('_netdev');
        }
        if (valOf(win, '#optAutomount')) {
            opts.push('x-systemd.automount');
            var idle = parseInt(valOf(win, '#optIdle'), 10);
            if (!isNaN(idle) && idle > 0) {
                opts.push('x-systemd.idle-timeout=' + idle);
            }
        }
        if (type === 'nfs') {
            var vers = valOf(win, '#nfsVers');
            if (vers) {
                opts.push('vers=' + vers);
            }
            opts.push(valOf(win, '#nfsHard') === false ? 'soft' : 'hard');
            var timeo = parseInt(valOf(win, '#nfsTimeo'), 10);
            if (!isNaN(timeo) && timeo > 0) {
                opts.push('timeo=' + timeo);
            }
            var retrans = parseInt(valOf(win, '#nfsRetrans'), 10);
            if (!isNaN(retrans) && retrans >= 0) {
                opts.push('retrans=' + retrans);
            }
            var rsize = parseInt(valOf(win, '#nfsRsize'), 10);
            if (!isNaN(rsize) && rsize > 0) {
                opts.push('rsize=' + rsize);
            }
            var wsize = parseInt(valOf(win, '#nfsWsize'), 10);
            if (!isNaN(wsize) && wsize > 0) {
                opts.push('wsize=' + wsize);
            }
            var proto = valOf(win, '#nfsProto');
            if (proto) {
                opts.push('proto=' + proto);
            }
            var nsec = valOf(win, '#nfsSec');
            if (nsec) {
                opts.push('sec=' + nsec);
            }
            var nconnect = parseInt(valOf(win, '#nfsNconnect'), 10);
            if (!isNaN(nconnect) && nconnect > 0) {
                opts.push('nconnect=' + nconnect);
            }
            var nactimeo = parseInt(valOf(win, '#nfsActimeo'), 10);
            if (!isNaN(nactimeo) && nactimeo >= 0) {
                opts.push('actimeo=' + nactimeo);
            }
            var lookupcache = valOf(win, '#nfsLookupcache');
            if (lookupcache) {
                opts.push('lookupcache=' + lookupcache);
            }
            if (valOf(win, '#nfsNoac')) {
                opts.push('noac');
            }
            if (valOf(win, '#nfsBg')) {
                opts.push('bg');
            }
        } else if (type === 'cifs') {
            var cvers = valOf(win, '#cifsVers');
            if (cvers) {
                opts.push('vers=' + cvers);
            }
            var ccache = valOf(win, '#cifsCache');
            if (ccache) {
                opts.push('cache=' + ccache);
            }
            var dom = ('' + (valOf(win, '#credDomain') || '')).trim();
            if (dom) {
                opts.push('domain=' + dom);
            }
            var uid = valOf(win, '#cifsUid');
            if (uid !== undefined && uid !== null && uid !== '') {
                opts.push('uid=' + uid);
            }
            if (valOf(win, '#cifsForceuid')) {
                opts.push('forceuid');
            }
            var gid = valOf(win, '#cifsGid');
            if (gid !== undefined && gid !== null && gid !== '') {
                opts.push('gid=' + gid);
            }
            if (valOf(win, '#cifsForcegid')) {
                opts.push('forcegid');
            }
            var fmode = ('' + (valOf(win, '#cifsFileMode') || '')).trim();
            if (fmode) {
                opts.push('file_mode=' + fmode);
            }
            var dmode = ('' + (valOf(win, '#cifsDirMode') || '')).trim();
            if (dmode) {
                opts.push('dir_mode=' + dmode);
            }
            var csec = valOf(win, '#cifsSec');
            if (csec) {
                opts.push('sec=' + csec);
            }
            var crsize = parseInt(valOf(win, '#cifsRsize'), 10);
            if (!isNaN(crsize) && crsize > 0) {
                opts.push('rsize=' + crsize);
            }
            var cwsize = parseInt(valOf(win, '#cifsWsize'), 10);
            if (!isNaN(cwsize) && cwsize > 0) {
                opts.push('wsize=' + cwsize);
            }
            var cactimeo = parseInt(valOf(win, '#cifsActimeo'), 10);
            if (!isNaN(cactimeo) && cactimeo >= 0) {
                opts.push('actimeo=' + cactimeo);
            }
            var iocharset = ('' + (valOf(win, '#cifsIocharset') || '')).trim();
            if (iocharset) {
                opts.push('iocharset=' + iocharset);
            }
            if (valOf(win, '#cifsMfsymlinks')) {
                opts.push('mfsymlinks');
            }
            if (valOf(win, '#cifsNoserverino')) {
                opts.push('noserverino');
            }
            if (valOf(win, '#cifsNobrl')) {
                opts.push('nobrl');
            }
            // Credentials live in a root-only file — never inline. Shown in the
            // preview as the reference the daemon will write.
            opts.push('credentials=/etc/anas/creds/<mount>.cred');
        }
        var extra = ('' + (valOf(win, '#extraOptions') || '')).trim();
        if (extra) {
            opts.push(extra);
        }
        return opts;
    }

    function fstabDevice(type, server, remotePath) {
        var srv = ('' + (server || '')).trim();
        var path = ('' + (remotePath || '')).trim();
        if (type === 'nfs') {
            var p = path ? (path.charAt(0) === '/' ? path : '/' + path) : '';
            return srv + ':' + p;
        }
        // cifs
        var share = path.replace(/^[\/\\]+/, '');
        return '//' + srv + '/' + share;
    }

    function updatePreview(win) {
        var cmp = win.down('#mountPreview');
        if (!cmp) {
            return;
        }
        try {
            var type = valOf(win, '#type') || 'nfs';
            var server = valOf(win, '#server');
            var remotePath = valOf(win, '#remotePath');
            var mp = valOf(win, '#mountpoint');
            if (!server || !remotePath || !mp) {
                cmp.update('<span style="color:var(--anas-muted,gray);">'
                    + enc(t('Fill in server, path and mountpoint to preview the fstab line.'))
                    + '</span>');
                return;
            }
            var dev = fstabDevice(type, server, remotePath);
            var opts = buildOptionList(win, type).join(',');
            var line = dev + '  ' + mp + '  ' + type + '  ' + opts + '  0  0';
            cmp.update('<pre style="margin:0;white-space:pre;overflow-x:auto;">' + enc(line) + '</pre>');
        } catch (e) {
            cmp.update('<span style="color:var(--anas-muted,gray);">' + enc(t('preview unavailable')) + '</span>');
        }
    }

    // ---- Test connection (POST /v1/mounts/test) ----------------------------

    function testBody(win) {
        var type = valOf(win, '#type') || 'nfs';
        var body = {
            type: type,
            server: ('' + (valOf(win, '#server') || '')).trim(),
            remotePath: ('' + (valOf(win, '#remotePath') || '')).trim(),
        };
        if (type === 'cifs') {
            var user = ('' + (valOf(win, '#credUser') || '')).trim();
            var pass = valOf(win, '#credPass');
            var dom = ('' + (valOf(win, '#credDomain') || '')).trim();
            if (user || pass || dom) {
                body.credentials = {};
                if (user) { body.credentials.username = user; }
                if (pass) { body.credentials.password = pass; }
                if (dom) { body.credentials.domain = dom; }
            }
        }
        return body;
    }

    // Distinct verdict rendering — the diagnosis, not just pass/fail. auth-failed
    // is worded "username or password" (CIFS cannot tell them apart — NOTES §6).
    var VERDICT_SPEC = {
        ok: { level: 'ok',
            msg: 'Reachable — the share answered. You can save this mount.' },
        unreachable: { level: 'bad',
            msg: 'Unreachable — no route to the server, or the service is not listening.' },
        'auth-failed': { level: 'warn',
            msg: 'Authentication failed — check the username or password (CIFS cannot tell the two apart).' },
        'not-found': { level: 'warn',
            msg: 'Not found — the export or share does not exist on the server.' },
        'protocol-mismatch': { level: 'warn',
            msg: 'Protocol mismatch — the server does not offer the requested version.' },
    };

    function renderTestVerdict(win, data) {
        var area = win.down('#testResult');
        if (!area) {
            return;
        }
        data = data || {};
        var verdict = ('' + first(data.verdict, data.stage, 'unreachable')).toLowerCase();
        var spec = VERDICT_SPEC[verdict] || { level: 'warn', msg: verdict };
        win._tested = (verdict === 'ok');
        var color = spec.level === 'bad' ? 'var(--anas-danger,#c23b2c)'
            : spec.level === 'warn' ? 'var(--anas-warn,#b06a12)' : 'var(--anas-ok,#1f9c56)';
        var text = t(spec.msg) + (data.detail ? (' — ' + data.detail) : '');
        var html;
        if (ANAS.gfx && typeof ANAS.gfx.callout === 'function') {
            html = ANAS.gfx.callout(enc(text), { level: spec.level });
        } else {
            html = '<span style="color:' + color + ';">' + enc(text) + '</span>';
        }
        try {
            area.update(html);
        } catch (e) {
            ANAS.warn('test verdict render failed: ' + ANAS.errText(e));
        }
    }

    function runTest(win, node) {
        var server = ('' + (valOf(win, '#server') || '')).trim();
        var remotePath = ('' + (valOf(win, '#remotePath') || '')).trim();
        if (!server || !remotePath) {
            ANAS.alertMsg('Invalid input', t('Enter a server and a share/export path to test.'));
            return;
        }
        var area = win.down('#testResult');
        if (area) {
            area.update('<span style="color:var(--anas-muted,gray);">'
                + '<i class="fa fa-refresh fa-spin" style="margin-right:6px;"></i>'
                + enc(t('testing…')) + '</span>');
        }
        ANAS.api.post(node, '/mounts/test', testBody(win)).then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            renderTestVerdict(win, (res && res.data) || {});
        }, function (err) {
            if (win.destroyed || win.destroying) {
                return;
            }
            ANAS.warn('mount test failed: ' + ANAS.errText(err));
            renderTestVerdict(win, { verdict: 'unreachable', detail: ANAS.errText(err) });
        });
    }

    // ---- Wizard field tiers -----------------------------------------------

    function commonTier() {
        return {
            xtype: 'fieldset',
            title: t('Common options'),
            collapsible: false,
            defaults: { anchor: '100%', labelWidth: 150 },
            items: [
                {
                    xtype: 'radiogroup',
                    itemId: 'roGroup',
                    fieldLabel: t('Access'),
                    columns: 2,
                    items: [
                        { boxLabel: t('Read/write'), name: 'roMode', inputValue: 'rw', checked: true },
                        { boxLabel: t('Read-only'), name: 'roMode', inputValue: 'ro' },
                    ],
                    listeners: {
                        change: function (f) {
                            // The group itself is read at preview/submit time (roOf);
                            // this listener only keeps the preview current.
                            var win = f.up('window');
                            if (win) {
                                updatePreview(win);
                            }
                        },
                    },
                },
                {
                    xtype: 'component',
                    cls: 'anas-mount-nofail',
                    style: 'margin:2px 0 8px 154px;color:var(--anas-ok,#1f9c56);font-size:12px;',
                    html: '<i class="fa fa-lock" style="margin-right:5px;"></i>'
                        + enc(t('nofail is always on — an absent server never blocks boot (forced).')),
                },
                {
                    xtype: 'checkboxfield',
                    itemId: 'optNoatime',
                    boxLabel: t('noatime (do not update access times)'),
                    hideLabel: true,
                    margin: '0 0 0 154',
                },
                {
                    xtype: 'checkboxfield',
                    itemId: 'optNosuid',
                    boxLabel: t('nosuid'),
                    hideLabel: true,
                    checked: true,
                    margin: '0 0 0 154',
                },
                {
                    xtype: 'checkboxfield',
                    itemId: 'optNodev',
                    boxLabel: t('nodev'),
                    hideLabel: true,
                    checked: true,
                    margin: '0 0 0 154',
                },
                {
                    xtype: 'checkboxfield',
                    itemId: 'optNoexec',
                    boxLabel: t('noexec (forbid running programs from the share)'),
                    hideLabel: true,
                    margin: '0 0 0 154',
                },
                {
                    xtype: 'checkboxfield',
                    itemId: 'optNetdev',
                    boxLabel: t('_netdev (wait for the network before mounting) — recommended for network shares'),
                    hideLabel: true,
                    checked: true,
                    margin: '0 0 4 154',
                },
                {
                    xtype: 'checkboxfield',
                    itemId: 'optAutomount',
                    fieldLabel: t('Automount'),
                    boxLabel: t('Mount on first access (x-systemd.automount) — good for flaky links'),
                    listeners: {
                        change: function (f) {
                            var win = f.up('window');
                            if (win) {
                                var idle = win.down('#optIdle');
                                if (idle) { idle.setDisabled(!f.getValue()); }
                                updatePreview(win);
                            }
                        },
                    },
                },
                {
                    xtype: 'numberfield',
                    itemId: 'optIdle',
                    fieldLabel: t('Idle timeout (s)'),
                    minValue: 0,
                    value: 60,
                    disabled: true,
                    emptyText: '60',
                },
            ],
        };
    }

    function nfsTier() {
        return {
            xtype: 'fieldset',
            itemId: 'nfsTier',
            title: t('NFS options'),
            hidden: false,
            defaults: { anchor: '100%', labelWidth: 150 },
            items: [
                {
                    xtype: 'combobox',
                    itemId: 'nfsVers',
                    fieldLabel: t('Version'),
                    store: NFS_VERS,
                    editable: false,
                    queryMode: 'local',
                    value: '4.2',
                },
                {
                    xtype: 'combobox',
                    itemId: 'nfsProto',
                    fieldLabel: t('Transport (proto)'),
                    store: NFS_PROTO,
                    editable: false,
                    queryMode: 'local',
                    value: '',
                },
                {
                    xtype: 'checkboxfield',
                    itemId: 'nfsHard',
                    fieldLabel: t('Hard mount'),
                    boxLabel: t('Retry indefinitely (hard) — recommended'),
                    checked: true,
                    listeners: {
                        change: function (f) {
                            var win = f.up('window');
                            if (win) {
                                var warn = win.down('#nfsSoftWarn');
                                if (warn) { warn.setHidden(!!f.getValue()); }
                                updatePreview(win);
                            }
                        },
                    },
                },
                {
                    xtype: 'component',
                    itemId: 'nfsSoftWarn',
                    hidden: true,
                    style: 'margin:0 0 8px 154px;color:var(--anas-warn,#b06a12);font-size:12px;',
                    html: '<i class="fa fa-exclamation-triangle" style="margin-right:5px;"></i>'
                        + enc(t('soft mounts can silently corrupt data on a server hiccup — '
                            + 'an I/O error is returned mid-write. Prefer hard unless you know why.')),
                },
                {
                    xtype: 'numberfield', itemId: 'nfsTimeo', fieldLabel: t('timeo (deciseconds)'),
                    minValue: 0, emptyText: t('server default'),
                },
                {
                    xtype: 'numberfield', itemId: 'nfsRetrans', fieldLabel: t('retrans'),
                    minValue: 0, emptyText: t('server default'),
                },
                {
                    xtype: 'numberfield', itemId: 'nfsRsize', fieldLabel: t('rsize (bytes)'),
                    minValue: 0, emptyText: t('negotiated'),
                },
                {
                    xtype: 'numberfield', itemId: 'nfsWsize', fieldLabel: t('wsize (bytes)'),
                    minValue: 0, emptyText: t('negotiated'),
                },
                {
                    xtype: 'fieldset',
                    itemId: 'nfsAdvanced',
                    title: t('Advanced NFS options'),
                    collapsible: true,
                    collapsed: true,
                    titleCollapse: true,
                    margin: '6 0 0 0',
                    defaults: { anchor: '100%', labelWidth: 150 },
                    items: [
                        {
                            xtype: 'combobox', itemId: 'nfsSec', fieldLabel: t('Security (sec)'),
                            store: NFS_SEC, editable: false, queryMode: 'local', value: '',
                        },
                        {
                            xtype: 'numberfield', itemId: 'nfsNconnect', fieldLabel: t('nconnect'),
                            minValue: 1, maxValue: 16, emptyText: t('1 (default)'),
                        },
                        {
                            xtype: 'numberfield', itemId: 'nfsActimeo', fieldLabel: t('actimeo (s)'),
                            minValue: 0, emptyText: t('default'),
                        },
                        {
                            xtype: 'combobox', itemId: 'nfsLookupcache', fieldLabel: t('lookupcache'),
                            store: NFS_LOOKUPCACHE, editable: false, queryMode: 'local', value: '',
                        },
                        {
                            xtype: 'checkboxfield', itemId: 'nfsNoac', hideLabel: true, margin: '0 0 0 154',
                            boxLabel: t('noac (disable attribute caching — stronger consistency, slower)'),
                        },
                        {
                            xtype: 'checkboxfield', itemId: 'nfsBg', hideLabel: true, margin: '0 0 0 154',
                            boxLabel: t('bg (retry the mount in the background at boot)'),
                        },
                    ],
                },
            ],
        };
    }

    function cifsTier(ownerStore, groupStore) {
        return {
            xtype: 'fieldset',
            itemId: 'cifsTier',
            title: t('CIFS / SMB options'),
            hidden: true,
            defaults: { anchor: '100%', labelWidth: 150 },
            items: [
                {
                    xtype: 'combobox',
                    itemId: 'cifsVers',
                    fieldLabel: t('SMB version'),
                    store: CIFS_VERS,
                    editable: false,
                    queryMode: 'local',
                    value: '3.1.1',
                    listeners: {
                        change: function (f) {
                            var win = f.up('window');
                            if (win) {
                                var warn = win.down('#cifsVersWarn');
                                if (warn) { warn.setHidden(f.getValue() !== '1.0'); }
                                updatePreview(win);
                            }
                        },
                    },
                },
                {
                    xtype: 'component',
                    itemId: 'cifsVersWarn',
                    hidden: true,
                    style: 'margin:0 0 8px 154px;color:var(--anas-danger,#c23b2c);font-size:12px;font-weight:600;',
                    html: '<i class="fa fa-exclamation-triangle" style="margin-right:5px;"></i>'
                        + enc(t('SMB 1.0 is insecure and deprecated — it exposes the host to known '
                            + 'attacks. Use it only for a legacy device that offers nothing newer.')),
                },
                {
                    xtype: 'combobox',
                    itemId: 'cifsCache',
                    fieldLabel: t('Cache'),
                    store: CIFS_CACHE,
                    editable: false,
                    queryMode: 'local',
                    value: '',
                },
                {
                    xtype: 'checkboxfield',
                    itemId: 'cifsMfsymlinks',
                    hideLabel: true,
                    margin: '0 0 4 154',
                    boxLabel: t('mfsymlinks (support symlinks on servers without Unix extensions)'),
                },
                {
                    xtype: 'combobox',
                    itemId: 'cifsUid',
                    fieldLabel: t('Owner (uid)'),
                    store: ownerStore,
                    valueField: 'id',
                    displayField: 'label',
                    queryMode: 'local',
                    editable: false,
                    emptyText: t('(default — root)'),
                    listeners: { change: function (f) { var w = f.up('window'); if (w) { updatePreview(w); } } },
                },
                {
                    xtype: 'checkboxfield',
                    itemId: 'cifsForceuid',
                    hideLabel: true,
                    margin: '0 0 4 154',
                    boxLabel: t('forceuid (always apply the owner above, ignore what the server reports)'),
                },
                {
                    xtype: 'combobox',
                    itemId: 'cifsGid',
                    fieldLabel: t('Group (gid)'),
                    store: groupStore,
                    valueField: 'id',
                    displayField: 'label',
                    queryMode: 'local',
                    editable: false,
                    emptyText: t('(default — root)'),
                    listeners: { change: function (f) { var w = f.up('window'); if (w) { updatePreview(w); } } },
                },
                {
                    xtype: 'checkboxfield',
                    itemId: 'cifsForcegid',
                    hideLabel: true,
                    margin: '0 0 4 154',
                    boxLabel: t('forcegid (always apply the group above, ignore what the server reports)'),
                },
                {
                    xtype: 'textfield', itemId: 'cifsFileMode', fieldLabel: t('file_mode'),
                    value: '0644', emptyText: '0644',
                    listeners: {
                        change: function (f) {
                            var w = f.up('window');
                            if (w) { refreshModeHint(w, '#cifsFileMode', '#cifsFileModeHint'); updatePreview(w); }
                        },
                    },
                },
                {
                    xtype: 'component',
                    itemId: 'cifsFileModeHint',
                    style: 'margin:0 0 6 154px;font-size:11px;',
                    html: '',
                },
                {
                    xtype: 'textfield', itemId: 'cifsDirMode', fieldLabel: t('dir_mode'),
                    value: '0755', emptyText: '0755',
                    listeners: {
                        change: function (f) {
                            var w = f.up('window');
                            if (w) { refreshModeHint(w, '#cifsDirMode', '#cifsDirModeHint'); updatePreview(w); }
                        },
                    },
                },
                {
                    xtype: 'component',
                    itemId: 'cifsDirModeHint',
                    style: 'margin:0 0 6 154px;font-size:11px;',
                    html: '',
                },
                {
                    xtype: 'fieldset',
                    itemId: 'cifsAdvanced',
                    title: t('Advanced CIFS options'),
                    collapsible: true,
                    collapsed: true,
                    titleCollapse: true,
                    margin: '6 0 0 0',
                    defaults: { anchor: '100%', labelWidth: 150 },
                    items: [
                        {
                            xtype: 'combobox', itemId: 'cifsSec', fieldLabel: t('Security (sec)'),
                            store: CIFS_SEC, editable: false, queryMode: 'local', value: '',
                        },
                        {
                            xtype: 'numberfield', itemId: 'cifsRsize', fieldLabel: t('rsize (bytes)'),
                            minValue: 0, emptyText: t('negotiated'),
                        },
                        {
                            xtype: 'numberfield', itemId: 'cifsWsize', fieldLabel: t('wsize (bytes)'),
                            minValue: 0, emptyText: t('negotiated'),
                        },
                        {
                            xtype: 'numberfield', itemId: 'cifsActimeo', fieldLabel: t('actimeo (s)'),
                            minValue: 0, emptyText: t('1 (default)'),
                        },
                        {
                            xtype: 'textfield', itemId: 'cifsIocharset', fieldLabel: t('iocharset'),
                            emptyText: 'utf8',
                        },
                        {
                            xtype: 'checkboxfield', itemId: 'cifsNoserverino', hideLabel: true, margin: '0 0 0 154',
                            boxLabel: t('noserverino (generate inode numbers locally)'),
                        },
                        {
                            xtype: 'checkboxfield', itemId: 'cifsNobrl', hideLabel: true, margin: '0 0 0 154',
                            boxLabel: t('nobrl (do not send byte-range locks — some legacy apps need this)'),
                        },
                    ],
                },
            ],
        };
    }

    function credentialsTier(isEdit) {
        return {
            xtype: 'fieldset',
            itemId: 'credTier',
            title: t('CIFS credentials'),
            hidden: true,
            defaults: { anchor: '100%', labelWidth: 150 },
            items: [
                {
                    xtype: 'component',
                    style: 'margin-bottom:8px;color:var(--anas-muted,gray);font-size:11px;',
                    html: enc(t('Stored in a root-only file under /etc/anas/creds/ — never inline in '
                        + 'fstab, never on the command line.')),
                },
                {
                    xtype: 'textfield', itemId: 'credUser', fieldLabel: t('Username'),
                    emptyText: 'smbuser',
                    // This dialog lives in the PVE origin: a user/password pair is
                    // exactly the shape a password manager autofills (issue #23).
                    inputAttrTpl: 'autocomplete="off"',
                },
                {
                    xtype: 'textfield', itemId: 'credPass', fieldLabel: t('Password'),
                    inputType: 'password',
                    emptyText: isEdit ? t('(unchanged)') : '',
                    // 'new-password' is the hint browsers honour on password inputs;
                    // bare 'off' is routinely ignored there.
                    inputAttrTpl: 'autocomplete="new-password"',
                    listeners: {
                        afterrender: function (f) {
                            // Second layer: on edit, only a secret the operator
                            // actually typed or pasted may rotate the creds file —
                            // an injected value must not (submitMount reads the flag).
                            try {
                                var el = f.inputEl && f.inputEl.dom;
                                if (!el) {
                                    // Cannot observe interaction: fall back to the
                                    // value test alone rather than blocking rotation.
                                    f._userTyped = true;
                                    return;
                                }
                                var mark = function () { f._userTyped = true; };
                                el.addEventListener('keydown', mark);
                                el.addEventListener('paste', mark);
                            } catch (eTyped) {
                                f._userTyped = true;
                                ANAS.warn('mount password wiring failed: ' + ANAS.errText(eTyped));
                            }
                        },
                    },
                },
                {
                    xtype: 'textfield', itemId: 'credDomain', fieldLabel: t('Domain (optional)'),
                    emptyText: 'WORKGROUP',
                    listeners: { change: function (f) { var w = f.up('window'); if (w) { updatePreview(w); } } },
                },
            ],
        };
    }

    // Toggle tier visibility when the protocol changes.
    function applyType(win, type) {
        try {
            var nfs = win.down('#nfsTier');
            var cifs = win.down('#cifsTier');
            var cred = win.down('#credTier');
            if (nfs) { nfs.setHidden(type !== 'nfs'); }
            if (cifs) { cifs.setHidden(type !== 'cifs'); }
            if (cred) { cred.setHidden(type !== 'cifs'); }
            var pathFld = win.down('#remotePath');
            if (pathFld) {
                pathFld.setFieldLabel(type === 'nfs' ? t('Export path') : t('Share name'));
            }
        } catch (e) {
            ANAS.warn('mount type toggle failed: ' + ANAS.errText(e));
        }
        updatePreview(win);
    }

    function openMountEdit(view, node, existing) {
        var isEdit = !!existing;
        var e = existing || {};
        var raw = e.raw || e;
        var eType = ('' + (first(raw.type, raw.fstype) || 'nfs')).toLowerCase();
        // Normalise nfs4 → nfs for the protocol chooser.
        var protoType = eType.indexOf('nfs') === 0 ? 'nfs' : (eType === 'cifs' ? 'cifs' : 'nfs');

        var ownerStore = Ext.create('Ext.data.Store', { fields: ['id', 'label'], data: [] });
        var groupStore = Ext.create('Ext.data.Store', { fields: ['id', 'label'], data: [] });

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-mount-edit',
                title: isEdit ? (t('Edit Remote Share') + ': ' + (e.mountpoint || raw.mountpoint || ''))
                    : t('Add Remote Share'),
                modal: true,
                width: 560,
                height: 640,
                resizable: true,
                layout: 'fit',
                items: [{
                    xtype: 'form',
                    itemId: 'form',
                    bodyPadding: 12,
                    border: false,
                    scrollable: true,
                    defaults: { anchor: '100%', labelWidth: 150 },
                    items: [
                        {
                            xtype: 'combobox',
                            itemId: 'type',
                            cls: 'anas-fld-mount-type',
                            fieldLabel: t('Protocol'),
                            store: [['nfs', t('NFS')], ['cifs', t('CIFS / SMB')]],
                            editable: false,
                            queryMode: 'local',
                            value: protoType,
                            disabled: isEdit, // the protocol is fixed for an existing mount
                            listeners: {
                                change: function (f) { applyType(f.up('window'), f.getValue()); },
                            },
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'server',
                            cls: 'anas-fld-mount-server',
                            fieldLabel: t('Server'),
                            emptyText: 'nas.example.com',
                            allowBlank: false,
                            // On edit this is filled from GET /mounts/:mp (detail.server),
                            // which parses the fstab spec — the summary row has no parts.
                            value: '',
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'remotePath',
                            cls: 'anas-fld-mount-path',
                            fieldLabel: protoType === 'nfs' ? t('Export path') : t('Share name'),
                            emptyText: protoType === 'nfs' ? '/srv/export1' : 'share1',
                            allowBlank: false,
                            // Filled on edit from detail.remotePath (parsed spec).
                            value: '',
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'mountpoint',
                            cls: 'anas-fld-mount-mountpoint',
                            fieldLabel: t('Mountpoint'),
                            emptyText: '/mnt/nas-share',
                            allowBlank: false,
                            readOnly: isEdit, // identity — cannot change on edit
                            value: e.mountpoint || raw.mountpoint || '',
                        },
                        {
                            xtype: 'button',
                            cls: 'anas-btn-mount-testconn',
                            text: t('Test connection'),
                            iconCls: 'fa fa-plug',
                            width: 160,
                            margin: '2 0 6 154',
                            handler: function () { runTest(win, node); },
                        },
                        {
                            xtype: 'component',
                            itemId: 'testResult',
                            cls: 'anas-mount-test',
                            margin: '0 0 8 0',
                            html: '<span style="color:var(--anas-muted,gray);font-size:12px;">'
                                + enc(t('Test diagnoses reachability, auth, and whether the share exists — '
                                    + 'a failed test warns but does not block saving.')) + '</span>',
                        },
                        commonTier(),
                        nfsTier(),
                        cifsTier(ownerStore, groupStore),
                        credentialsTier(isEdit),
                        {
                            xtype: 'textfield',
                            itemId: 'extraOptions',
                            cls: 'anas-fld-mount-extra',
                            fieldLabel: t('Additional options'),
                            emptyText: t('comma-separated, passed through verbatim'),
                            listeners: { change: function (f) { var w = f.up('window'); if (w) { updatePreview(w); } } },
                        },
                        {
                            xtype: 'checkboxfield',
                            itemId: 'persist',
                            cls: 'anas-fld-mount-persist',
                            fieldLabel: t('Persist'),
                            boxLabel: t('Write an /etc/fstab entry (off = mount now only)'),
                            readOnly: isEdit, // identity — cannot change on edit
                            checked: (first(raw.persistent, raw.inFstab) !== false),
                        },
                        {
                            xtype: 'component',
                            style: 'margin:8px 0 3px;color:var(--anas-muted,gray);font-size:11px;',
                            html: enc(t('fstab line preview (the daemon is authoritative):')),
                        },
                        {
                            xtype: 'component',
                            itemId: 'mountPreview',
                            cls: 'anas-mount-preview',
                            // line-height + min-height so the monospace line is not
                            // vertically clipped; grows to content, long lines scroll
                            // horizontally inside the box (see updatePreview's <pre>).
                            style: 'padding:8px 10px;border-radius:6px;background:rgba(127,127,127,0.10);'
                                + 'font-family:monospace;font-size:12px;line-height:1.5;'
                                + 'min-height:20px;overflow-x:auto;',
                            html: '',
                        },
                    ],
                }],
                buttons: [
                    { text: t('Cancel'), handler: function () { win.close(); } },
                    {
                        text: isEdit ? t('Save') : t('Add'),
                        itemId: 'saveBtn',
                        cls: 'anas-btn-mount-save',
                        disabled: true,
                        handler: function () {
                            try {
                                submitMount(win, view, node, isEdit);
                            } catch (ex) {
                                ANAS.warn('mount save failed: ' + ANAS.errText(ex));
                            }
                        },
                    },
                ],
            });
        } catch (ex) {
            ANAS.warn('mount edit window failed: ' + ANAS.errText(ex));
            return;
        }

        // Load identity lists for the owner/group pickers.
        loadOwnerOptions(node, ownerStore);
        loadGroupOptions(node, groupStore);

        // Wire preview + save-enable. Save is enabled once the required fields
        // are filled; a failed test warns but never hard-blocks (warn-never-fail).
        var refreshSave = function () {
            var ok = !!(('' + (valOf(win, '#server') || '')).trim()
                && ('' + (valOf(win, '#remotePath') || '')).trim()
                && MP_RE.test('' + (valOf(win, '#mountpoint') || '')));
            var btn = win.down('#saveBtn');
            if (btn) { btn.setDisabled(!ok); }
        };
        var onChange = function () {
            updatePreview(win);
            refreshSave();
        };

        try {
            // Suggest a mountpoint from server+path while the user has not typed one.
            var maybeSuggest = function () {
                var mpFld = win.down('#mountpoint');
                if (!mpFld || isEdit || (mpFld.getValue() || '').length || mpFld._userTyped) {
                    return;
                }
                var s = suggestMountpoint(valOf(win, '#server'), valOf(win, '#remotePath'));
                if (s) { mpFld.setValue(s); }
            };
            win.down('#server').on('change', function () { maybeSuggest(); onChange(); });
            win.down('#remotePath').on('change', function () { maybeSuggest(); onChange(); });
            win.down('#mountpoint').on('change', onChange);
            win.down('#mountpoint').on('dirtychange', function (f) { f._userTyped = true; });
            // Blanket: any field change refreshes the preview.
            var fields = win.down('#form').query('field');
            for (var i = 0; i < fields.length; i++) {
                fields[i].on('change', function () { updatePreview(win); });
            }
        } catch (eWire) {
            ANAS.warn('mount wizard wiring failed: ' + ANAS.errText(eWire));
        }

        win.show();
        applyType(win, protoType);
        onChange();
        // Seed the human-readable mode hints from the default field values.
        refreshModeHint(win, '#cifsFileMode', '#cifsFileModeHint');
        refreshModeHint(win, '#cifsDirMode', '#cifsDirModeHint');

        // On edit, the grid summary row lacks the structured options, the parsed
        // server/share, and the saved username — those live only in the detail
        // (GET /mounts/:mp). Fetch it and populate every field so the dialog
        // round-trips the existing entry (blank Server/Share + disabled Save was
        // the reported bug). onChange re-enables Save once the required fields fill.
        if (isEdit) {
            populateFromDetail(win, node, e.mountpoint || raw.mountpoint || '', onChange);
        }
    }

    // Set a field's value by itemId selector, tolerating absent fields; skips
    // undefined/null so an omitted option keeps the form default.
    function setFld(win, sel, v) {
        if (v === undefined || v === null) {
            return;
        }
        try {
            var f = win.down(sel);
            if (f) { f.setValue(v); }
        } catch (e) {
            // non-fatal
        }
    }

    // Set a checkbox by itemId to an explicit boolean (false must uncheck).
    function setChk(win, sel, on) {
        try {
            var f = win.down(sel);
            if (f) { f.setValue(!!on); }
        } catch (e) {
            // non-fatal
        }
    }

    // Fetch GET /mounts/:mp (MountDetail) and populate the edit dialog from the
    // parsed spec (server/remotePath), the structured configuredOptions, and the
    // saved CIFS username. Password is deliberately left blank — the secret is
    // never returned; a blank password on save means "keep the existing one".
    function populateFromDetail(win, node, mountpoint, onChange) {
        if (!mountpoint) {
            return;
        }
        ANAS.api.get(node, '/mounts/' + encMp(mountpoint)).then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            var d = (res && res.data) || {};
            var co = d.configuredOptions || {};
            var common = co.common || {};

            // Connection (parsed from the fstab spec by the daemon).
            setFld(win, '#server', d.server);
            setFld(win, '#remotePath', d.remotePath);

            // Common options. Access is a radiogroup, not a checkbox — set the
            // group's value map (roOf reads the same group back at submit time).
            try {
                var roGroup = win.down('#roGroup');
                if (roGroup) { roGroup.setValue({ roMode: common.readOnly ? 'ro' : 'rw' }); }
            } catch (eRo) {
                // non-fatal
            }
            setChk(win, '#optNoatime', common.noatime);
            setChk(win, '#optNosuid', common.nosuid);
            setChk(win, '#optNodev', common.nodev);
            setChk(win, '#optNoexec', common.noexec);
            setChk(win, '#optNetdev', common.netdev);
            setChk(win, '#optAutomount', common.automount);
            setFld(win, '#optIdle', common.automountIdleTimeout);

            // Persistence.
            if (d.persistent === true || d.persistent === false) {
                setChk(win, '#persist', d.persistent);
            }

            // NFS tier.
            var nfs = co.nfs || {};
            setFld(win, '#nfsVers', nfs.vers);
            setChk(win, '#nfsHard', nfs.hard !== false); // default hard when unset
            setFld(win, '#nfsTimeo', nfs.timeo);
            setFld(win, '#nfsRetrans', nfs.retrans);
            setFld(win, '#nfsRsize', nfs.rsize);
            setFld(win, '#nfsWsize', nfs.wsize);
            setFld(win, '#nfsProto', nfs.proto);
            setFld(win, '#nfsSec', nfs.sec);
            setFld(win, '#nfsNconnect', nfs.nconnect);
            setFld(win, '#nfsActimeo', nfs.actimeo);
            setFld(win, '#nfsLookupcache', nfs.lookupcache);
            setChk(win, '#nfsNoac', nfs.noac === true);
            setChk(win, '#nfsBg', nfs.bg === true);

            // CIFS tier.
            var cifs = co.cifs || {};
            setFld(win, '#cifsVers', cifs.vers);
            setFld(win, '#cifsCache', cifs.cache);
            // Domain lives in the credentials section; for a hand-written inline
            // entry it is surfaced via d.credentials.domain (never a cifs option).
            setFld(win, '#credDomain', first(cifs.domain, d.credentials && d.credentials.domain));
            setFld(win, '#cifsUid', cifs.uid);
            setChk(win, '#cifsForceuid', cifs.forceuid === true);
            setFld(win, '#cifsGid', cifs.gid);
            setChk(win, '#cifsForcegid', cifs.forcegid === true);
            setFld(win, '#cifsFileMode', cifs.fileMode);
            setFld(win, '#cifsDirMode', cifs.dirMode);
            setFld(win, '#cifsSec', cifs.sec);
            setFld(win, '#cifsRsize', cifs.rsize);
            setFld(win, '#cifsWsize', cifs.wsize);
            setFld(win, '#cifsActimeo', cifs.actimeo);
            setFld(win, '#cifsIocharset', cifs.iocharset);
            setChk(win, '#cifsMfsymlinks', cifs.mfsymlinks === true);
            setChk(win, '#cifsNoserverino', cifs.noserverino === true);
            setChk(win, '#cifsNobrl', cifs.nobrl === true);
            refreshModeHint(win, '#cifsFileMode', '#cifsFileModeHint');
            refreshModeHint(win, '#cifsDirMode', '#cifsDirModeHint');

            // Unrecognized options round-trip verbatim through the extra field.
            setFld(win, '#extraOptions', co.passthrough);

            // Saved CIFS username (never the password).
            if (d.credentials && d.credentials.username) {
                setFld(win, '#credUser', d.credentials.username);
            }

            if (typeof onChange === 'function') { onChange(); }
        }, function (err) {
            ANAS.warn('mount detail load for edit failed: ' + ANAS.errText(err));
        });
    }

    function submitMount(win, view, node, isEdit) {
        var form = win.down('#form');
        var basicForm = form && form.getForm();
        if (basicForm && basicForm.isValid && !basicForm.isValid()) {
            ANAS.alertMsg('Invalid input', t('Fill in the required fields.'));
            return;
        }
        var type = valOf(win, '#type') || 'nfs';
        var server = ('' + (valOf(win, '#server') || '')).trim();
        var remotePath = ('' + (valOf(win, '#remotePath') || '')).trim();
        var mountpoint = ('' + (valOf(win, '#mountpoint') || '')).trim();
        if (!server || !remotePath) {
            ANAS.alertMsg('Invalid input', t('Enter a server and a share/export path.'));
            return;
        }
        if (!MP_RE.test(mountpoint)) {
            ANAS.alertMsg('Invalid input', t('Mountpoint must be an absolute path (e.g. /mnt/nas-share).'));
            return;
        }

        // Structured known-tier options + free-text passthrough. nofail is FORCED
        // by the daemon, so we do NOT send it as a choice.
        var options = {
            ro: roOf(win),
            noatime: !!valOf(win, '#optNoatime'),
            nosuid: !!valOf(win, '#optNosuid'),
            nodev: !!valOf(win, '#optNodev'),
            noexec: !!valOf(win, '#optNoexec'),
            netdev: !!valOf(win, '#optNetdev'),
        };
        var automount = !!valOf(win, '#optAutomount');
        if (automount) {
            var idle = parseInt(valOf(win, '#optIdle'), 10);
            if (!isNaN(idle) && idle > 0) {
                options.idleTimeout = idle;
            }
        }
        if (type === 'nfs') {
            options.vers = valOf(win, '#nfsVers') || '4.2';
            options.hard = valOf(win, '#nfsHard') !== false;
            var timeo = parseInt(valOf(win, '#nfsTimeo'), 10);
            if (!isNaN(timeo)) { options.timeo = timeo; }
            var retrans = parseInt(valOf(win, '#nfsRetrans'), 10);
            if (!isNaN(retrans)) { options.retrans = retrans; }
            var rsize = parseInt(valOf(win, '#nfsRsize'), 10);
            if (!isNaN(rsize) && rsize > 0) { options.rsize = rsize; }
            var wsize = parseInt(valOf(win, '#nfsWsize'), 10);
            if (!isNaN(wsize) && wsize > 0) { options.wsize = wsize; }
            var proto = valOf(win, '#nfsProto');
            if (proto) { options.proto = proto; }
            var nsec = valOf(win, '#nfsSec');
            if (nsec) { options.sec = nsec; }
            var nconnect = parseInt(valOf(win, '#nfsNconnect'), 10);
            if (!isNaN(nconnect) && nconnect > 0) { options.nconnect = nconnect; }
            var nactimeo = parseInt(valOf(win, '#nfsActimeo'), 10);
            if (!isNaN(nactimeo) && nactimeo >= 0) { options.actimeo = nactimeo; }
            var lookupcache = valOf(win, '#nfsLookupcache');
            if (lookupcache) { options.lookupcache = lookupcache; }
            options.noac = !!valOf(win, '#nfsNoac');
            options.bg = !!valOf(win, '#nfsBg');
        } else if (type === 'cifs') {
            options.vers = valOf(win, '#cifsVers') || '3.1.1';
            var ccache = valOf(win, '#cifsCache');
            if (ccache) { options.cache = ccache; }
            var dom = ('' + (valOf(win, '#credDomain') || '')).trim();
            if (dom) { options.domain = dom; }
            var uid = valOf(win, '#cifsUid');
            if (uid !== undefined && uid !== null && uid !== '') { options.uid = uid; }
            options.forceuid = !!valOf(win, '#cifsForceuid');
            var gid = valOf(win, '#cifsGid');
            if (gid !== undefined && gid !== null && gid !== '') { options.gid = gid; }
            options.forcegid = !!valOf(win, '#cifsForcegid');
            var fmode = ('' + (valOf(win, '#cifsFileMode') || '')).trim();
            if (fmode) { options.fileMode = fmode; }
            var dmode = ('' + (valOf(win, '#cifsDirMode') || '')).trim();
            if (dmode) { options.dirMode = dmode; }
            var csec = valOf(win, '#cifsSec');
            if (csec) { options.sec = csec; }
            var crsize = parseInt(valOf(win, '#cifsRsize'), 10);
            if (!isNaN(crsize) && crsize > 0) { options.rsize = crsize; }
            var cwsize = parseInt(valOf(win, '#cifsWsize'), 10);
            if (!isNaN(cwsize) && cwsize > 0) { options.wsize = cwsize; }
            var cactimeo = parseInt(valOf(win, '#cifsActimeo'), 10);
            if (!isNaN(cactimeo) && cactimeo >= 0) { options.actimeo = cactimeo; }
            var iocharset = ('' + (valOf(win, '#cifsIocharset') || '')).trim();
            if (iocharset) { options.iocharset = iocharset; }
            options.mfsymlinks = !!valOf(win, '#cifsMfsymlinks');
            options.noserverino = !!valOf(win, '#cifsNoserverino');
            options.nobrl = !!valOf(win, '#cifsNobrl');
        }

        var body = {
            type: type,
            server: server,
            remotePath: remotePath,
            mountpoint: mountpoint,
            automount: automount,
            options: options,
        };
        if (!isEdit) {
            // Persistence is create-time only — the PUT does not act on it, so
            // sending it would be a control that lies (issue #27).
            body.persistent = !!valOf(win, '#persist');
        }
        var extra = ('' + (valOf(win, '#extraOptions') || '')).trim();
        if (extra) {
            body.extraOptions = extra;
        }
        if (type === 'cifs') {
            var user = ('' + (valOf(win, '#credUser') || '')).trim();
            var passFld = win.down('#credPass');
            var pass = passFld ? passFld.getValue() : '';
            // A password manager can fill this field inside the PVE origin; only a
            // typed/pasted secret counts as a rotation on edit (issue #23).
            var passTyped = !!(passFld && passFld._userTyped);
            if (!isEdit) {
                // Create: credentials are required (the daemon enforces it). Send
                // whatever was typed; the schema requires username + password.
                var creds = {};
                if (user) { creds.username = user; }
                if (pass) { creds.password = pass; }
                if (dom) { creds.domain = dom; }
                body.credentials = creds;
            } else if (pass && passTyped) {
                // Edit: only ROTATE when a new password is entered. Username and
                // password travel together (the creds file needs both, and the
                // schema requires both). A blank (or merely autofilled) password
                // means "keep the existing credentials" — omit the block so the
                // daemon leaves the 0600 creds file untouched. (Domain still
                // round-trips as a mount option.)
                var creds2 = { username: user, password: pass };
                if (dom) { creds2.domain = dom; }
                body.credentials = creds2;
            }
        }

        ANAS.runJob({
            node: node,
            method: isEdit ? 'put' : 'post',
            path: isEdit ? ('/mounts/' + encMp(mountpoint)) : '/mounts',
            body: body,
            view: win,
            failTitle: isEdit ? 'Save failed' : 'Add failed',
            successMsg: (isEdit ? t('Mount saved') : t('Mount added')) + ': ' + mountpoint,
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                loadMounts(view, node);
                loadMountDetail(view, node, mountpoint);
            },
        });
    }

    // ---- Poll loop control (visibility-gated) ------------------------------

    function startPolling(view, node) {
        var grid = mountsGridOf(view);
        if (!grid || grid.destroyed || grid.destroying) {
            return;
        }
        stopPolling(view);
        try {
            view._anasTimer = setInterval(function () {
                try {
                    var g = mountsGridOf(view);
                    if (!g || g.destroyed || g.destroying) {
                        stopPolling(view);
                        return;
                    }
                    if (typeof document !== 'undefined' && document.hidden) {
                        return;
                    }
                    if (typeof g.isVisible === 'function' && !g.isVisible()) {
                        return;
                    }
                    loadMounts(view, node, true);
                } catch (tickErr) {
                    ANAS.warn('mounts poll tick failed: ' + ANAS.errText(tickErr));
                }
            }, POLL_MS);
        } catch (e) {
            ANAS.warn('mounts interval start failed: ' + ANAS.errText(e));
        }
    }

    function stopPolling(view) {
        try {
            if (view && view._anasTimer) {
                clearInterval(view._anasTimer);
                view._anasTimer = null;
            }
        } catch (e) {
            // non-fatal
        }
    }

    function cleanup(view) {
        stopPolling(view);
        try {
            if (view && view._anasVisHandler && typeof document !== 'undefined'
                && document.removeEventListener) {
                document.removeEventListener('visibilitychange', view._anasVisHandler);
                view._anasVisHandler = null;
            }
        } catch (e) {
            // non-fatal
        }
    }

    // ---- View --------------------------------------------------------------

    function mountsView(node) {
        var store = Ext.create('Ext.data.Store', {
            fields: [
                'mountpoint', 'source', 'type', 'state',
                { name: 'persistent', type: 'auto' },
                { name: 'pveManaged', type: 'auto' },
                { name: 'pveStorages', type: 'auto' },
                { name: 'ahrManaged', type: 'auto' },
                { name: 'remote', type: 'auto' },
                { name: 'size', type: 'auto' },
                { name: 'used', type: 'auto' },
                { name: 'automount', type: 'auto' },
                { name: 'raw', type: 'auto' },
            ],
            data: [],
            sorters: [{ property: 'mountpoint', direction: 'ASC' }],
        });

        var tbar = [
            {
                text: t('Reload'),
                cls: 'anas-btn-refresh anas-btn-mount-refresh',
                iconCls: 'fa fa-refresh',
                handler: function (btn) {
                    loadMounts(btn.up('#mountsView'), node);
                },
            },
            {
                text: t('Add Remote Share…'),
                cls: 'anas-btn-mount-add',
                iconCls: 'fa fa-plus',
                handler: function (btn) {
                    openMountEdit(btn.up('#mountsView'), node, null);
                },
            },
            '-',
            {
                text: t('Unmount'),
                itemId: 'mountToggle',
                cls: 'anas-btn-mount-toggle',
                iconCls: 'fa fa-stop',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#mountsView');
                    mountToggle(view, node, selectedMount(mountsGridOf(view)));
                },
            },
            {
                text: t('Edit'),
                itemId: 'mountEdit',
                cls: 'anas-btn-mount-edit',
                iconCls: 'fa fa-pencil',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#mountsView');
                    var rec = selectedMount(mountsGridOf(view));
                    openMountEdit(view, node, rec ? rec.getData() : null);
                },
            },
            {
                text: t('Disable'),
                itemId: 'mountDisable',
                cls: 'anas-btn-mount-disable',
                iconCls: 'fa fa-ban',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#mountsView');
                    mountEnableDisable(view, node, selectedMount(mountsGridOf(view)));
                },
            },
            {
                text: t('Remove'),
                itemId: 'mountRemove',
                cls: 'anas-btn-mount-remove',
                iconCls: 'fa fa-trash',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#mountsView');
                    removeMount(view, node, selectedMount(mountsGridOf(view)));
                },
            },
        ];

        return {
            xtype: 'panel',
            itemId: 'mountsView',
            cls: 'anas-view anas-view-mounts',
            title: t('Mounts'),
            layout: { type: 'vbox', align: 'stretch' },
            border: false,
            items: [
                {
                    xtype: 'gridpanel',
                    itemId: 'mountsGrid',
                    cls: 'anas-grid-mounts',
                    flex: 1,
                    border: false,
                    store: store,
                    selModel: { mode: 'SINGLE' },
                    emptyText: t('No mounts found'),
                    viewConfig: {
                        getRowClass: function (record) {
                            try {
                                return isPveManaged(record) ? 'anas-mount-pve-row'
                                    : (isAhrManaged(record) ? 'anas-mount-ahr-row' : '');
                            } catch (e) {
                                return '';
                            }
                        },
                    },
                    columns: [
                        {
                            text: t('Mountpoint'), dataIndex: 'mountpoint',
                            flex: 1, minWidth: 200, renderer: renderMountpoint,
                        },
                        {
                            text: t('Source'), dataIndex: 'source',
                            flex: 1, minWidth: 180, sortable: false, menuDisabled: true,
                            renderer: renderSource,
                        },
                        {
                            text: t('Type'), dataIndex: 'type', width: 130,
                            renderer: renderType,
                        },
                        {
                            text: t('State'), dataIndex: 'state', width: 150,
                            align: 'center', renderer: renderState,
                        },
                        {
                            text: t('Capacity'), dataIndex: 'used', width: 160,
                            sortable: false, menuDisabled: true, renderer: renderCapacity,
                        },
                        {
                            text: t('Persist'), dataIndex: 'persistent', width: 90,
                            align: 'center', renderer: renderPersisted,
                        },
                    ],
                    tbar: tbar,
                    listeners: {
                        selectionchange: function (selModel, selected) {
                            var grid = this;
                            // Ignore the transient empty selection fired by
                            // loadData during a poll refresh — loadMounts
                            // restores selection and detail itself.
                            if (grid.anasReloading && !(selected && selected.length)) {
                                return;
                            }
                            updateButtons(grid);
                            var view = grid.up('#mountsView');
                            var rec = (selected && selected.length) ? selected[0] : null;
                            loadMountDetail(view, node, rec ? rec.get('mountpoint') : null);
                        },
                        itemdblclick: function (grid, rec) {
                            if (!rec || isPveManaged(rec) || isAhrManaged(rec) || !isRemoteRec(rec)) {
                                return;
                            }
                            openMountEdit(grid.up('#mountsView'), node, rec.getData());
                        },
                    },
                },
                {
                    xtype: 'panel',
                    itemId: 'mountDetail',
                    cls: 'anas-mount-detail',
                    height: 240,
                    border: false,
                    scrollable: true,
                    bodyStyle: 'border-top:1px solid var(--anas-line,#dfe3e8);',
                    html: detailHint(),
                },
            ],
            listeners: {
                afterrender: function (view) {
                    loadMounts(view, node);
                    startPolling(view, node);
                    try {
                        view._anasVisHandler = function () {
                            try {
                                if (document.hidden) {
                                    stopPolling(view);
                                } else if (typeof view.isVisible === 'function' && view.isVisible()) {
                                    startPolling(view, node);
                                }
                            } catch (e2) {
                                // non-fatal
                            }
                        };
                        if (typeof document !== 'undefined' && document.addEventListener) {
                            document.addEventListener('visibilitychange', view._anasVisHandler);
                        }
                    } catch (e3) {
                        // non-fatal
                    }
                },
                activate: function (view) {
                    loadMounts(view, node);
                    startPolling(view, node);
                },
                deactivate: function (view) {
                    stopPolling(view);
                },
                show: function (view) {
                    startPolling(view, node);
                },
                hide: function (view) {
                    stopPolling(view);
                },
                beforedestroy: function (view) {
                    cleanup(view);
                },
                destroy: function (view) {
                    cleanup(view);
                },
            },
        };
    }

    // ---- View registration -------------------------------------------------

    ANAS.views['mounts'] = {
        itemId: 'anas-mounts',
        text: t('Mounts'),
        iconCls: 'fa fa-plug',
        factory: function (node) {
            try {
                return mountsView(node);
            } catch (e) {
                ANAS.warn('mounts view failed: ' + ANAS.errText(e));
                return ANAS.errorPanel(ANAS.errText(e));
            }
        },
    };
})();
