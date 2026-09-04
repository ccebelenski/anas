/*
 * ANAS — Backup view (Epic 16: PBS file backup — 16.4 / 16.5 UI / 16.6 / 16.10).
 *
 * A native ExtJS "Backup" menu item (sibling of Replication / Mounts). File-level
 * backup of host paths to a Proxmox Backup Server via proxmox-backup-client. The
 * view is the sibling of the Replication view: a task grid + detail area, a
 * create/edit task wizard with Run Now, and a Repositories manager modeled on the
 * replication Remotes manager.
 *
 * OPERATOR RULING (binding): ANAS NEVER contacts the PBS server for status. All
 * task status is LOCAL-ONLY — last result / next run / overdue from persistent
 * systemd unit+timer state, recent run detail from journald (labeled recent-only:
 * it rotates, older history simply ages out), live progress from the job. The ONLY
 * PBS-server contacts are backup runs themselves and the explicit user-initiated
 * repository Test. Server-side truth (snapshot history, sizes, verify state) lives
 * in the PBS UI — the detail area LINKS there, never rebuilds or polls it.
 *
 * ---------------------------------------------------------------------------
 * DAEMON CONTRACT — field names this view assumes beyond DESIGN.md's endpoint
 * table. Every read is defensive: absent / renamed fields degrade to a muted
 * dash, never an error.
 *
 *   GET /v1/backup/tasks → { data: TaskEntry[] }, each:
 *     { task, lastRunResult, lastRunAt, nextRunAt, overdue,
 *       lunName? (backup2.9 — BLOCK tasks only: the LUN's name READ LIVE from
 *         the iSCSI read layer; the unit stores the record + the serial, never
 *         the display name. null = the read layer cannot resolve it right now
 *         — a state to SHOW, not a dash. Absent for files tasks and on older
 *         daemons) }
 *     task = { name, repository (repo NAME; alias `repo`), datastore? (else joined
 *              from the repos list), namespace?, backupId (alias `backup-id`/
 *              `backupID`),
 *              kind? (backup2.9 — 'files'|'block', the STORED value; ABSENT on
 *              a unit written before this story, exactly as the archive's kind.
 *              The EFFECTIVE kind is derived: exactly one img archive is a
 *              block task, everything else is files — and a derived files task
 *              that still carries image archive(s) is the legacy shape the
 *              wizard's note points at. A send may carry `kind: 'block'` ONLY
 *              for a task whose unit stored it: that is what keeps a
 *              pre-backup2.9 LUN task's hand-chosen id and PBS group, which
 *              the daemon's serial guard would otherwise refuse),
 *              archives:[{name, path, excludes:[],
                kind? ('pxar'|'img' — backup2.4; ABSENT means 'pxar'),
                lun? ({ targetIqn, index } — backup2.4 — the LUN an img source
                  was picked as; display + restore truth, the path is still
                  the source),
                includeNested? ('none'|'all'|[absolute paths] — backup2.2;
                  ABSENT means 'none', the client's own behaviour, and the
                  dialog NEVER writes a default on an untouched save)}],
 *              changeDetectionMode ('default'|'metadata'; alias `changeDetection`),
 *              retention? ({keepLast?,keepDaily?,keepWeekly?,keepMonthly?,keepYearly?}
 *                — positive ints; ABSENT means ANAS never prunes, 16.11),
 *              notify ('always'|'on-failure' — when a finished run notifies
 *                through PVE, 16.12; ABSENT means 'always', the daemon's
 *                default and vzdump's),
 *              schedule (OnCalendar), enabled (bool),
 *              cadence? (16.10 — the STRUCTURED schedule:
 *                { kind:'weekly'|'biweekly'|'monthly'|'custom', days:[Mon..Sun],
 *                  time:'HH:MM', parity?:'even'|'odd' }. Present ⇒ the daemon
 *                GENERATED `schedule` from it and the cadence is authoritative;
 *                absent ⇒ `schedule` is a hand-written expression, which is what
 *                every pre-16.10 task carries) }
 *     lastRunResult ('success'|'failure'|'running'|'skipped'|'unknown'|'disabled'
 *     |'never-run' — 'skipped' is a biweekly off-week fire: it ran and
 *     deliberately did nothing, which is neither a success nor a failure;
 *     'disabled' and 'never-run' are the ABSENCE of a result, not an outcome:
 *     a disabled unit's history is garbage-collected by systemd (F9), and an
 *     enabled unit with empty run timestamps has simply never fired),
 *     lastRunAt (ISO),
 *     nextRunAt (ISO), overdue (bool — a silently-overdue task counts as failed,
 *     the replication policy).
 *
 *   GET /v1/backup/tasks/:name → { data: TaskDetail } (name URL-encoded):
 *     the task fields above, PLUS:
 *       unit  (string — the .service unit file, verbatim; alias `serviceUnit`)
 *       timer (string — the .timer unit file, verbatim; alias `timerUnit`)
 *       recentRuns (array of { at, result, exitCode?, output? }; alias `runs`)
 *         OR journal (string — a recent journald blob; alias `recentOutput`)
 *
 *   GET /v1/backup/repos → { data: { version, repos:[Repo] } }
 *       (an array `data` is tolerated → version 0). Repo (read):
 *       { name, host, port (default 8007), datastore, namespace?, authType
 *         ('token'|'password'; alias `auth`), tokenId? (token identity),
 *         username? (password identity), credentialsSet (alias `credsSet`),
 *         fingerprint (alias `certFingerprint`) }
 *   POST /v1/backup/repos          body { repo, expectedVersion }  (CAS, 202 job)
 *   PUT  /v1/backup/repos/:name    body { repo, expectedVersion }  (CAS, 202 job)
 *   DELETE /v1/backup/repos/:name?expectedVersion=N               (CAS, 202/409)
 *       A 409 on any repo write = the registry moved under us: reload + toast +
 *       re-prompt, NEVER blind-retry (the replication-remotes discipline).
 *     Repo (write) adds write-only `secret` (the token secret OR the password —
 *       the daemon knows which from authType) and identity `tokenId`/`username`.
 *       On edit, `secret` is OMITTED when blank (= unchanged). Never prefilled.
 *   POST /v1/backup/repos/test → { data: { stage, detail?, fingerprint? } }
 *       stage (alias `verdict`): 'ok'|'dns'|'tcp'|'tls-fingerprint'|'auth'|
 *       'datastore'|'namespace'. Body: a Repo (write) shape for a NOT-yet-
 *       registered repo (from the dialog), OR { name } to test a REGISTERED repo
 *       using its stored secret (the manager-grid Test — the secret is write-only,
 *       so the daemon must load it). `fingerprint` returned on the tls stage for
 *       explicit confirmation (no silent TOFU).
 *
 *   POST /v1/backup/tasks            body TaskWrite (create)      → 202 { job }
 *   PUT  /v1/backup/tasks/:name      body TaskWrite (edit/toggle) → 202 { job }
 *   DELETE /v1/backup/tasks/:name    (units removed; PBS data untouched) → 202/409
 *   POST /v1/backup/tasks/:name/run  (Run Now; job carries progress) → 202 { job }
 *     TaskWrite = { name, repository, namespace?, backupId,
 *       kind? (backup2.9 — 'block' for a NEW block task, or for an edit of a
 *         task whose UNIT STORED it; never 'files' — absent IS the files
 *         default, so a files task stays byte-identical on every save, and a
 *         pre-backup2.9 LUN task keeps its id + group), archives,
 *       mode (=changeDetectionMode — a block task sends 'default': the control
 *         does not exist for one), retention?, notify, enabled, and EITHER
 *       `cadence` (structured — the daemon derives the OnCalendar; this view
 *       never generates one) OR `schedule` (the raw expression, for the
 *       Custom kind)}.
 *     The finished job's `result` may carry `prune` ({group, namespace?, dryRun,
 *       kept, removed, protectedCount, snapshots[]}) and `warnings[]` — a prune
 *       that failed AFTER a successful backup is a WARNING on a COMPLETED job,
 *       never a failure (the backup data is already safe).
 *   POST /v1/backup/tasks/:name/prune-preview → { data: { verdict, detail?,
 *       result? } } — the retention DRY RUN behind the wizard's Preview button
 *       (16.11). verdict: 'ok'|'not-found'|'permission'|'error' ('not-found'
 *       honestly covers group OR namespace — PBS cannot tell them apart). Body
 *       may carry { repository, namespace?, backupId, retention } inline so an
 *       UNSAVED task previews; omitted fields fall back to the stored task.
 *       User-initiated, one-shot, non-mutating — never polled.
 *
 *   POST /v1/backup/tasks/preview-nested → { data: { archives:[Scan] } } — the
 *       wizard's LOCAL boundary scan + the DERIVED per-source `consistency`.
 *       Body { path, includeNested, kind? } for one row, or { archives:[…] }.
 *       An 'img' row sends kind:'img' and the daemon skips the tree walk.
 *   GET /v1/backup/lun-sources → { data: { installed, reason?, luns:[
 *       {targetIqn, index, name, kind:'zvol'|'file', path, serial, size,
 *        backingExists, consistency?}] } } — the 'img' path field's LUN picker
 *       (backup2.4).
 *       READ-ONLY, LOCAL-ONLY, and a convenience: free-typing a device or image
 *       path stays first-class. `installed:false` is a normal answer, not an
 *       error — most nodes serve no block storage.
 *
 *   Path-picker candidates (convenience, best-effort — free-typing always works):
 *     GET /v1/mounts (mountpoints) + GET /v1/pools then
 *     GET /v1/pools/:name/datasets (dataset mountpoints).
 * ---------------------------------------------------------------------------
 *
 * Test hooks: view 'anas-view anas-view-backup'; grid 'anas-grid-backup'; toolbar
 * 'anas-btn-backup-refresh' / '-new' / '-repos' / '-run' / '-edit' / '-toggle' /
 * '-delete' / '-details'; detail window 'anas-win-backup-detail' (body
 * 'anas-backup-detail', reload 'anas-btn-backup-detail-reload'); task window
 * 'anas-win-backup-task' (submit 'anas-btn-backup-task-submit', task-kind
 * choice 'anas-fld-backup-kind' — backup2.9, hidden on edit and on a
 * door-pre-filled block wizard; files panel 'anas-backup-files' (archives
 * 'anas-backup-archives', legacy note 'anas-backup-legacy-note', per-row path
 * browse 'anas-btn-backup-arch-browse', per-row nested choice
 * 'anas-fld-backup-arch-nested' with its path list
 * 'anas-fld-backup-arch-nested-paths' and inline alert
 * 'anas-backup-arch-nested-alert', per-row kind 'anas-fld-backup-arch-kind'
 * with its name suffix 'anas-backup-arch-suffix', LUN button
 * 'anas-btn-backup-arch-lun' and image note 'anas-backup-arch-image-note');
 * block panel 'anas-backup-block' (backup2.9 — LUN facts
 * 'anas-backup-block-lun', choose button 'anas-btn-backup-block-lun', archive
 * name 'anas-fld-backup-block-name'); LUN picker 'anas-win-backup-lun-picker'
 * (grid 'anas-grid-backup-lun-picker', select 'anas-btn-backup-lun-select');
 * schedule fieldset 'anas-backup-schedule' with 'anas-fld-backup-cadence' /
 * '-day' / '-single-day' / '-parity' / '-time' / '-schedule');
 * retention fieldset 'anas-backup-retention' with 'anas-fld-backup-keeplast' …
 * 'anas-fld-backup-keepyearly', preview 'anas-btn-backup-retention-preview'
 * rendering into 'anas-backup-retention-preview');
 * notification mode combo 'anas-fld-backup-notify';
 * directory picker: the SHARED widget from 12-picker.js —
 * 'anas-win-path-picker' (tree 'anas-tree-path-picker', path field
 * 'anas-fld-picker-path', select 'anas-btn-picker-select'); repos manager
 * 'anas-win-backup-repos' (grid 'anas-grid-backup-repos'); repo edit
 * 'anas-win-backup-repo-edit' (test area 'anas-backup-repo-test', save
 * 'anas-btn-backup-repo-save').
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

    // Reload cadence while the view is visible — matches replication / mounts.
    var POLL_MS = 10000;

    // Task / repo names: same shape as replication tasks + remotes.
    var NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
    // PBS listens on 8007 by default (proxmox-backup-client's default port).
    var PBS_PORT = 8007;

    // Module-level cache of repo NAME → { datastore, host, port } so the task grid
    // can render "repository:datastore" without the task carrying the datastore.
    // Refreshed on every task reload; fail-open (empty ⇒ datastore simply omitted).
    var REPO_MAP = {};

    function t(str) {
        return ANAS.t ? ANAS.t(str) : str;
    }

    function enc(s) {
        return ANAS.enc(s);
    }

    function gfxReady() {
        return ANAS.gfx && ANAS.gfx.ready ? ANAS.gfx.ready() : false;
    }

    // First defined, non-empty argument (defensive field aliasing).
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

    function trim(v) {
        return ('' + (v == null ? '' : v)).replace(/^\s+|\s+$/g, '');
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

    // ---- Small formatters (mirror replication) -----------------------------

    function relTime(iso) {
        if (iso === undefined || iso === null || iso === '') {
            return '';
        }
        try {
            var ms = new Date(iso).getTime();
            if (isNaN(ms)) {
                return '';
            }
            var diff = Date.now() - ms;
            var future = diff < 0;
            var s = Math.abs(diff) / 1000;
            var out;
            if (s < 60) {
                out = Math.round(s) + 's';
            } else if (s < 3600) {
                out = Math.round(s / 60) + 'm';
            } else if (s < 86400) {
                out = Math.round(s / 3600) + 'h';
            } else {
                out = Math.round(s / 86400) + 'd';
            }
            return future ? (t('in') + ' ' + out) : (out + ' ' + t('ago'));
        } catch (e) {
            return '';
        }
    }

    function absTime(iso) {
        if (!iso) {
            return '';
        }
        try {
            var d = new Date(iso);
            if (isNaN(d.getTime())) {
                return '' + iso;
            }
            if (typeof Ext !== 'undefined' && Ext.Date && typeof Ext.Date.format === 'function') {
                return Ext.Date.format(d, 'Y-m-d H:i');
            }
            return d.toLocaleString();
        } catch (e) {
            return '' + iso;
        }
    }

    // Split a multiline excludes blob into a trimmed, non-empty pattern array.
    function splitLines(v) {
        var out = [];
        var lines = ('' + (v == null ? '' : v)).split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            var s = trim(lines[i]);
            if (s) {
                out.push(s);
            }
        }
        return out;
    }

    // A task's archive names carry an implied suffix (`.pxar`, or `.img` for a
    // block image — backup2.4); the wizard shows the bare name. Strip a suffix a
    // user typed so we never double it.
    function bareArchive(name) {
        return trim(name).replace(/\.(?:pxar|img)$/i, '');
    }

    function pillHtml(label, color, title) {
        return '<span' + (title ? ' title="' + enc(title) + '"' : '')
            + ' style="display:inline-block;padding:1px 9px;border-radius:9px;font-size:0.85em;'
            + 'color:#fff;background:' + color + ';">' + enc(label) + '</span>';
    }

    // ---- Task normalisation ------------------------------------------------

    function archivesOf(task) {
        var raw = (task && (task.archives || task.archive)) || [];
        var out = [];
        if (!isArray(raw)) {
            return out;
        }
        for (var i = 0; i < raw.length; i++) {
            var a = raw[i] || {};
            var row = {
                name: bareArchive(first(a.name, a.archive) || ''),
                path: '' + (a.path == null ? '' : a.path),
                excludes: isArray(a.excludes) ? a.excludes
                    : (isArray(a.exclude) ? a.exclude : []),
            };
            // backup2.2 — carry the nested choice through VERBATIM, and only
            // when it is really there. ABSENT stays absent (that is what makes
            // an untouched edit byte-identical); 'none' is dropped because it
            // means exactly the same thing and would otherwise be written.
            var nested = nestedChoiceOf(a);
            if (nested !== 'none') {
                row.includeNested = nested;
            }
            // backup2.4 — same rule for the archive KIND and the LUN record:
            // absent means 'pxar', so 'pxar' is never written back.
            if (archiveKindOf(a) === 'img') {
                row.kind = 'img';
                var lun = lunRefOf(a);
                if (lun) {
                    row.lun = lun;
                }
            }
            out.push(row);
        }
        return out;
    }

    // ---- Archive kind (backup2.4) ------------------------------------------
    //
    // An archive is either a FILE ARCHIVE of a directory tree (`pxar`, every
    // archive before this story) or a BLOCK IMAGE of a device or a raw image
    // file (`img`). The two are not variations of one thing:
    //   - excludes and nested-filesystem coverage mean nothing on a block image
    //     (the daemon REFUSES both on an `img` archive), so the wizard hides AND
    //     disables those controls rather than leaving stale values readable;
    //   - the change-detection mode does not apply at all, and every run reads
    //     the whole image — both stated in the row, because a silent surprise on
    //     a 512 GiB LUN is the expensive kind;
    //   - a live LUN's image is CRASH-consistent, which is a weaker promise than
    //     a snapshot and is said out loud.

    /** 'pxar' | 'img' — the one reader of the stored field (absent = pxar). */
    function archiveKindOf(archive) {
        return (archive && archive.kind === 'img') ? 'img' : 'pxar';
    }

    /** The stored { targetIqn, index } LUN record, or null. Never invented. */
    function lunRefOf(archive) {
        var l = archive && archive.lun;
        if (!l || typeof l !== 'object') {
            return null;
        }
        var iqn = trim(l.targetIqn);
        var idx = l.index;
        if (!iqn || typeof idx !== 'number' || idx < 0) {
            return null;
        }
        return { targetIqn: iqn, index: idx };
    }

    /** `<target> LUN <n>` — the LUN identity, spelled out, never truncated. */
    function lunLabel(lun) {
        return lun ? (lun.targetIqn + '  ' + t('LUN') + ' ' + lun.index) : '';
    }

    // ---- Task kind (backup2.9) ---------------------------------------------
    //
    // A task is FILES (directory trees) or BLOCK (one iSCSI LUN as a whole
    // image) — not a bag of archives with a mixed agenda. The stored kind is
    // ABSENT on a unit written before this story, and the effective answer is
    // derived exactly as the shared schema derives it (the harness pins the
    // two): exactly one image archive is a block task, everything else is
    // files — and a derived files task that still carries image archive(s) is
    // the legacy shape the wizard's note points at (one block task per LUN).
    //
    // Stored vs derived is what the edit dialog turns on: a STORED `block` is
    // sent back on save, a derived one is not — which keeps a pre-backup2.9
    // task's hand-chosen id and PBS group, the daemon's serial guard refusing
    // exactly the send a derived task must not make.

    /** The fixed archive name of a block task (mirrors the shared constant): the whole image IS the archive. */
    var BLOCK_ARCHIVE_NAME = 'disk';

    /** The backup-id a new block task gets: `lun-<SCSI unit serial>` (mirrors the shared helper). */
    function lunBackupId(serial) {
        return 'lun-' + serial;
    }

    /**
     * The archive name a row gets when it is CREATED (mirrors the shared
     * deriveArchiveName): the source path's last segment, sanitised to the
     * archive-name charset, auto-suffixed `-2`, `-3`, … against the names the
     * task already carries. A STORED name is never re-derived — the name is
     * pbc's change-detection key, and re-deriving it (a path rename changing
     * the last segment) would silently turn the next run into a full re-read.
     */
    function deriveArchiveName(path, taken) {
        var p = ('' + (path == null ? '' : path)).replace(/\/+$/, '');
        var segments = p.split('/');
        var last = '';
        for (var i = 0; i < segments.length; i++) {
            if (segments[i]) {
                last = segments[i];
            }
        }
        var base = last.replace(/[^\w.-]/g, '_');
        if (!base) {
            base = 'root'; // the path was `/` — take the filesystem's own name
        }
        var name = base;
        var n = 2;
        taken = taken || [];
        while (taken.indexOf(name) >= 0) {
            name = base + '-' + (n++);
        }
        return name.length > 128 ? name.substring(0, 128) : name;
    }

    /**
     * The one answer to "what IS this task" (mirrors the shared
     * effectiveTaskKind): the stored kind, or derived when the unit predates
     * the field.
     */
    function taskKindOf(task) {
        task = task || {};
        var archives = archivesOf(task);
        var imgCount = 0;
        for (var i = 0; i < archives.length; i++) {
            if (archiveKindOf(archives[i]) === 'img') {
                imgCount++;
            }
        }
        if (task.kind === 'block' || task.kind === 'files') {
            return { kind: task.kind, legacyImgArchives: false };
        }
        if (archives.length === 1 && imgCount === 1) {
            return { kind: 'block', legacyImgArchives: false };
        }
        return { kind: 'files', legacyImgArchives: imgCount > 0 };
    }

    // ---- Nested filesystems (backup2.2) ------------------------------------
    //
    // pbc walks ONE filesystem: anything under a source with a different st_dev
    // (a child dataset, a btrfs subvolume, /etc/pve, an NFS/CIFS mount) is stored
    // as an EMPTY DIRECTORY unless the archive says otherwise. The daemon detects
    // them (POST /backup/tasks/preview-nested — LOCAL only, no PBS contact); this
    // file only shows what it found and carries the choice.

    /** 'none' | 'all' | [paths] — the one reader of the stored field. */
    function nestedChoiceOf(archive) {
        var v = archive && archive.includeNested;
        if (v === 'all') {
            return 'all';
        }
        if (isArray(v)) {
            var paths = [];
            for (var i = 0; i < v.length; i++) {
                var p = trim(v[i]);
                if (p) {
                    paths.push(p);
                }
            }
            if (paths.length) {
                return paths;
            }
        }
        return 'none';
    }

    /** Which of the three radio/combo positions a stored choice maps to. */
    function nestedModeOf(archive) {
        var choice = nestedChoiceOf(archive);
        return choice === 'all' ? 'all' : (choice === 'none' ? 'none' : 'choose');
    }

    var NESTED_KIND_LABEL = {
        dataset: 'child dataset',
        subvolume: 'btrfs subvolume',
        nfs: 'NFS mount',
        cifs: 'SMB/CIFS mount',
        local: 'local filesystem',
        pmxcfs: 'pmxcfs',
        automount: 'automount (armed)',
        unknown: 'unknown filesystem',
    };

    function nestedKindLabel(kind) {
        var k = '' + (kind || 'unknown');
        return NESTED_KIND_LABEL[k] || k;
    }

    /** The entries a scan says are NOT covered by the current choice. */
    function excludedNested(scan) {
        var out = [];
        var list = (scan && scan.nested) || [];
        if (!isArray(list)) {
            return out;
        }
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].included !== true) {
                out.push(list[i]);
            }
        }
        return out;
    }

    /** The entries a scan says ARE covered — the ones that become archives. */
    function includedNestedOf(scan) {
        var out = [];
        var list = (scan && scan.nested) || [];
        if (!isArray(list)) {
            return out;
        }
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].included === true) {
                out.push(list[i]);
            }
        }
        return out;
    }

    // ---- Snapshot consistency (backup2.3) ----------------------------------
    //
    // READ-ONLY. The daemon DERIVES whether a source can be backed up from a
    // point-in-time snapshot (ZFS dataset, AHR pool on the @data/@snapshots
    // layout) or has to be read live (remote mounts, foreign filesystems, a flat
    // AHR pool). Nothing here is editable and nothing is sent back — this file
    // only renders the verdict and its reason. It arrives on the SAME
    // preview-nested scan the boundary alert already uses.

    /** The derived consistency of one scan, or null when the daemon did not say. */
    function consistencyOf(scan) {
        var c = scan && scan.consistency;
        if (!c || typeof c !== 'object') {
            return null;
        }
        return c.consistency === 'snapshot' ? c : (c.consistency === 'live' ? c : null);
    }

    /**
     * The read-only chip. `snapshot` is the good state (one instant captured);
     * `live` is neither an error nor a warning — it is the honest statement that
     * this filesystem cannot give a point in time — so it renders muted, with
     * the daemon's own reason as the tooltip.
     */
    function consistencyChipHtml(scan) {
        var c = consistencyOf(scan);
        if (!c) {
            return '';
        }
        var snap = c.consistency === 'snapshot';
        return pillHtml(snap ? t('snapshot') : t('live'),
            snap ? 'var(--anas-ok,#1f9c56)' : 'var(--anas-muted,gray)',
            '' + (c.reason || ''));
    }

    /**
     * "N nested filesystems → N+1 archives" — what snapshot mode will actually
     * hand the backup client. Only shown when the source IS snapshot-capable AND
     * the current choice covers at least one nested filesystem: a live source
     * expands into nothing, and `none` keeps exactly one archive.
     */
    function expansionLineHtml(scan) {
        var c = consistencyOf(scan);
        if (!c || c.consistency !== 'snapshot') {
            return '';
        }
        var included = includedNestedOf(scan);
        if (!included.length) {
            return '';
        }
        var n = included.length;
        return enc(n + ' '
            + (n === 1 ? t('nested filesystem') : t('nested filesystems'))
            + ' → ' + (n + 1) + ' ' + t('archives'));
    }

    // ---- Cadence (16.10) ---------------------------------------------------
    //
    // A task's schedule is still an OnCalendar expression; `cadence` is the
    // structured form this wizard edits, and the DAEMON generates the expression
    // from it (the generator lives once, in the shared schema — this file never
    // reimplements systemd calendar syntax). A task without a cadence is a raw
    // OnCalendar task, which is what every pre-16.10 task is: it opens on the
    // Custom tab with its expression prefilled, and saving it changes nothing.

    var WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    var WEEKDAY_LABEL = {
        Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday',
        Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday',
    };
    var CADENCE_KINDS = ['weekly', 'biweekly', 'monthly', 'custom'];
    var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
    // The fire time the operator's own jobs use — a sane default, freely editable.
    var DEFAULT_TIME = '02:00';

    // A task's cadence, normalised; null when the task carries a raw schedule.
    function cadenceOf(task) {
        var c = task && task.cadence;
        if (!c || CADENCE_KINDS.indexOf('' + c.kind) < 0 || c.kind === 'custom') {
            return null;
        }
        var days = [];
        var raw = isArray(c.days) ? c.days : [];
        for (var i = 0; i < WEEKDAYS.length; i++) {
            for (var j = 0; j < raw.length; j++) {
                if (raw[j] === WEEKDAYS[i]) {
                    days.push(WEEKDAYS[i]);
                    break;
                }
            }
        }
        return {
            kind: '' + c.kind,
            days: days,
            time: '' + (c.time || ''),
            parity: c.parity ? ('' + c.parity) : '',
        };
    }

    // A cadence in words. Deliberately spells out what the timer alone cannot say
    // (which weeks a biweekly task runs) — the whole point of the feature.
    function cadenceText(c) {
        if (!c) {
            return '';
        }
        var days = c.days.join(', ');
        if (c.kind === 'weekly') {
            return t('Weekly') + ' · ' + days + ' · ' + c.time;
        }
        if (c.kind === 'biweekly') {
            return t('Every other week') + ' · ' + days + ' · ' + c.time + ' · '
                + (c.parity === 'even' ? t('even ISO weeks') : t('odd ISO weeks'));
        }
        if (c.kind === 'monthly') {
            return t('Monthly') + ' · ' + t('first') + ' ' + days + ' · ' + c.time;
        }
        return '';
    }

    function repoNameOf(task) {
        return first(task && task.repository, task && task.repo) || '';
    }

    function datastoreOf(task) {
        var explicit = first(task && task.datastore);
        if (explicit) {
            return explicit;
        }
        var r = REPO_MAP[repoNameOf(task)];
        return (r && r.datastore) || '';
    }

    function backupIdOf(task) {
        return first(task && task.backupId, task && task['backup-id'], task && task.backupID) || '';
    }

    function modeOf(task) {
        return ('' + (first(task && task.changeDetectionMode, task && task.changeDetection,
            task && task.mode) || 'default')).toLowerCase();
    }

    // ---- Retention (16.11) -------------------------------------------------
    // The five PBS --keep-* values, in the order the fieldset and the summary
    // show them. Blank/absent = unset: ANAS then never runs prune at all.
    var KEEP_FIELDS = [
        { key: 'keepLast', label: 'Keep last' },
        { key: 'keepDaily', label: 'Keep daily' },
        { key: 'keepWeekly', label: 'Keep weekly' },
        { key: 'keepMonthly', label: 'Keep monthly' },
        { key: 'keepYearly', label: 'Keep yearly' }
    ];

    // A task's retention as a plain object of the keeps actually set (positive
    // integers only) — anything else is dropped, so a broken value can never
    // become a keep flag.
    function retentionOf(task) {
        var raw = (task && task.retention) || {};
        var out = {};
        for (var i = 0; i < KEEP_FIELDS.length; i++) {
            var n = Number(raw[KEEP_FIELDS[i].key]);
            if (!isNaN(n) && n > 0 && n === Math.floor(n)) {
                out[KEEP_FIELDS[i].key] = n;
            }
        }
        return out;
    }

    // ---- Notifications (16.12) ---------------------------------------------
    // When a finished run notifies through PVE — vzdump's own two modes, with
    // vzdump's own default. ABSENT means 'always' (the daemon's schema default),
    // which is exactly what every task created before 16.12 reads back as.
    //
    // The normalizer + combo live in ANAS.notifyMode (00-core) since 9.4 gave
    // snapshot schedules and replication the same knob; backup keeps only its own
    // DEFAULT here, which is deliberately the loud one (see NotifyMode).
    function notifyOf(task) {
        return ANAS.notifyMode.of(first(task && task.notify), 'always');
    }

    // ---- LimitNOFILE -------------------------------------------------------
    // The generated unit carries LimitNOFILE=<task.limitNofile> — a real prlimit
    // on pbc, raised by hand on nodes where metadata mode hoards descriptors.
    // No dialog control edits it, so every PUT (edit AND enable/disable, both of
    // which rewrite the WHOLE task) has to carry the stored value through, or
    // the next save silently resets a hand-raised limit to the schema default
    // and rewrites the unit. Same rule as cadence, notify and retention.
    function limitNofileOf(task) {
        var n = Number(first(task && task.limitNofile, task && task.limitNoFile,
            task && task['limit-nofile']));
        return (!isNaN(n) && n > 0 && n === Math.floor(n)) ? n : undefined;
    }

    function hasKeeps(retention) {
        for (var k in retention) {
            if (Object.prototype.hasOwnProperty.call(retention, k)) {
                return true;
            }
        }
        return false;
    }

    // "keep last 3, daily 7" — the labels the PBS flags carry, never a guess.
    function retentionSummary(retention) {
        var parts = [];
        for (var i = 0; i < KEEP_FIELDS.length; i++) {
            var v = retention[KEEP_FIELDS[i].key];
            if (v !== undefined) {
                parts.push(KEEP_FIELDS[i].label.toLowerCase().replace(/^keep /, '') + ' ' + v);
            }
        }
        return parts.length ? (t('keep') + ' ' + parts.join(', ')) : '';
    }

    // Flatten a { task, ...runtime } entry into a grid record; keep the raw task
    // under 'raw' so edit / toggle can round-trip it.
    function taskRow(entry) {
        entry = entry || {};
        var task = entry.task || entry || {};
        var archives = archivesOf(task);
        return {
            name: task.name,
            repository: repoNameOf(task),
            datastore: datastoreOf(task),
            namespace: first(task.namespace) || '',
            backupId: backupIdOf(task),
            // backup2.9 — the EFFECTIVE kind (derived when the unit predates
            // the field) and the LUN's live name for a block task. `lunName`
            // stays `undefined` for files tasks (the daemon omits the key) so
            // the renderer can tell "no LUN column for this shape" from a
            // block task whose LUN no longer resolves (`null`). `storedKind`
            // keeps the STORED value off by itself — the save must send that,
            // never the derived answer.
            kind: taskKindOf(task).kind,
            storedKind: (task.kind === 'block' || task.kind === 'files') ? task.kind : undefined,
            lunName: ('lunName' in entry) ? entry.lunName : undefined,
            archiveCount: archives.length,
            mode: modeOf(task),
            schedule: task.schedule,
            cadence: cadenceOf(task),
            notify: notifyOf(task),
            limitNofile: limitNofileOf(task),
            enabled: task.enabled !== false,
            lastRunResult: first(entry.lastRunResult, entry.result) || 'unknown',
            lastRunAt: first(entry.lastRunAt, entry.lastRun),
            nextRunAt: first(entry.nextRunAt, entry.nextRun),
            overdue: entry.overdue === true,
            raw: task,
        };
    }

    // Reconstruct a task object from a grid record when the raw form is absent.
    function taskFromRecord(rec) {
        var raw = rec.get('raw');
        if (raw) {
            return raw;
        }
        return {
            name: rec.get('name'),
            repository: rec.get('repository'),
            namespace: rec.get('namespace'),
            backupId: rec.get('backupId'),
            // backup2.9 — the STORED kind only (`rec.get('kind')` is the
            // effective answer: a derived-block task must not start claiming
            // block on a save).
            kind: (rec.get('storedKind') === 'block' || rec.get('storedKind') === 'files')
                ? rec.get('storedKind')
                : undefined,
            archives: [],
            changeDetectionMode: rec.get('mode'),
            schedule: rec.get('schedule'),
            cadence: rec.get('cadence') || undefined,
            notify: rec.get('notify') || 'always',
            limitNofile: rec.get('limitNofile') || undefined,
            enabled: !!rec.get('enabled'),
        };
    }

    // ---- Renderers ---------------------------------------------------------

    // "repo:datastore" with the namespace appended when set (never truncated).
    function renderRepo(v, meta, rec) {
        var repo = '' + (rec.get('repository') || '');
        var ds = '' + (rec.get('datastore') || '');
        var ns = '' + (rec.get('namespace') || '');
        if (!repo && !ds) {
            return '<span style="color:gray;">&mdash;</span>';
        }
        var main = enc(repo);
        if (ds) {
            main += '<span style="color:var(--anas-muted,gray);">:</span>'
                + '<span style="font-family:monospace;">' + enc(ds) + '</span>';
        }
        if (ns) {
            main += ' <span class="anas-backup-ns" title="' + enc(t('PBS namespace')) + '"'
                + ' style="display:inline-block;padding:0 6px;border-radius:8px;font-size:0.8em;'
                + 'color:var(--anas-accent,#3468c0);'
                + 'background:color-mix(in srgb,var(--anas-accent,#3468c0) 14%,transparent);">'
                + enc(ns) + '</span>';
        }
        return '<span title="' + enc(repo + (ds ? ':' + ds : '') + (ns ? ' / ' + ns : '')) + '">'
            + main + '</span>';
    }

    // backup-id → the PBS group identity (host/<id>); shown whole, monospace.
    function renderBackupId(v) {
        var id = '' + (v == null ? '' : v);
        if (!id) {
            return '<span style="color:gray;">&mdash;</span>';
        }
        return '<span title="' + enc('host/' + id) + '" style="font-family:monospace;font-size:0.92em;">'
            + enc(id) + '</span>';
    }

    // backup2.9 — the effective kind. Block is the exceptional shape (the one
    // with a LUN column beside it), so it wears the accent; files reads muted.
    function renderKind(v) {
        if (v === 'block') {
            return pillHtml(t('block'), 'var(--anas-accent,#3468c0)',
                t('a whole iSCSI LUN as one block image — one LUN per task'));
        }
        return '<span style="color:var(--anas-muted,gray);">' + enc(t('files')) + '</span>';
    }

    // backup2.9 — the LUN a block task backs up, by its LIVE name (it is
    // display-only and never stored — read where it lives). Files tasks get a
    // dash; a block task whose LUN no longer resolves says so, amber — a
    // resolved-null is a state, not an absence of data. An OLDER daemon omits
    // the field entirely (absent, not null) — both are the same unresolved
    // state; neither may render the literal string "undefined".
    function renderLunName(v, meta, rec) {
        if (!rec || !rec.get || rec.get('kind') !== 'block') {
            return '<span style="color:gray;">&mdash;</span>';
        }
        if (v == null) {
            return '<span style="color:var(--anas-warn,#c9820b);">'
                + enc(t('no longer resolvable')) + '</span>';
        }
        return '<span style="font-family:monospace;" title="'
            + enc(t('The LUN this block task backs up — the name is read live and can change; '
                + 'the backups are keyed to the LUN, not the name')) + '">'
            + enc(v) + '</span>';
    }

    // Archive count → a labelled number (numbers get labeled context).
    function renderArchives(v) {
        var n = Number(v);
        if (isNaN(n)) {
            return '<span style="color:gray;">&mdash;</span>';
        }
        var label = n + ' ' + (n === 1 ? t('archive') : t('archives'));
        return '<span title="' + enc(label) + '">' + enc(label) + '</span>';
    }

    // A structured cadence reads in words (it says which weeks a biweekly task
    // runs — the thing the OnCalendar expression cannot); a raw schedule reads as
    // the expression itself. Either way the generated expression is in the tooltip,
    // never truncated.
    function renderSchedule(v, meta, rec) {
        var s = '' + (v == null ? '' : v);
        var c = rec ? rec.get('cadence') : null;
        var text = cadenceText(c);
        if (!s && !text) {
            return '<span style="color:gray;">&mdash;</span>';
        }
        if (text) {
            return '<span title="' + enc(text + (s ? ' — OnCalendar: ' + s : '')) + '">'
                + enc(text) + '</span>';
        }
        return '<span title="' + enc(s) + '" style="font-family:monospace;font-size:0.92em;">'
            + enc(s) + '</span>';
    }

    // The one sentence a `disabled` result carries, wherever it is rendered
    // (grid pill and task detail). Live-proof F9.
    // The daemon's own sentence, repeated here only as the fallback for an older
    // daemon that has the status but not the note.
    var DISABLED_HISTORY_SENTENCE = 'run history is not retained while a task is disabled';

    var DISABLED_RESULT_TIP = 'Disabled — systemd does not keep the run history of a task whose timer is off, so there is no last result to show. The recent journald output on the detail is the only record left.';

    // The one sentence a `never-run` result carries, wherever it is rendered
    // (grid pill and task detail). The enabled twin of the F9 hole: an enabled
    // unit is kept loaded by its timer, so empty run timestamps mean it has
    // never fired — the default-valued Result=success was a fabricated success.
    var NEVER_RUN_TIP = 'this task has not run yet';

    // A muted, outlined pill — for a state that is an ABSENCE of a result
    // rather than an outcome, so it must not wear an outcome's solid colour.
    function softPill(label, color, title) {
        return '<span' + (title ? ' title="' + enc(title) + '"' : '')
            + ' style="display:inline-block;padding:0 8px;border-radius:9px;font-size:0.85em;'
            + 'color:' + color + ';border:1px solid ' + color + ';">' + enc(label) + '</span>';
    }

    // Last run: a result pill + the relative time. An overdue task is flagged
    // (silently-overdue counts as failed — the replication policy).
    function renderLastRun(v, meta, rec) {
        var result = '' + (rec.get('lastRunResult') || 'unknown');
        var at = rec.get('lastRunAt');
        var overdue = rec.get('overdue') === true;
        var pill;
        if (result === 'success' && !overdue) {
            pill = pillHtml(t('success'), 'var(--anas-ok,#1f9c56)', absTime(at));
        } else if (result === 'skipped' && !overdue) {
            // A biweekly off week: the fire happened and deliberately did nothing.
            // Neither a success (no backup was taken) nor a failure (nothing broke).
            pill = pillHtml(t('skipped (off week)'), 'var(--anas-muted,gray)',
                t('An off-week fire of an every-other-week task — nothing was backed up, '
                    + 'and nothing is wrong.') + (at ? ' ' + absTime(at) : ''));
        } else if (result === 'failure') {
            pill = pillHtml(t('failure'), 'var(--anas-danger,#c23b2c)', absTime(at));
        } else if (result === 'running') {
            pill = '<span title="' + enc(t('running')) + '"'
                + ' style="display:inline-block;padding:1px 9px;border-radius:9px;font-size:0.85em;'
                + 'color:#fff;background:var(--anas-accent,#3468c0);">'
                + '<i class="fa fa-refresh fa-spin" aria-hidden="true" style="margin-right:4px;"></i>'
                + enc(t('running')) + '</span>';
        } else if (result === 'disabled') {
            // Live-proof F9: a DISABLED task has no timer referencing its unit,
            // so systemd unloads it and garbage-collects the run history. The
            // grid used to read `success / never` regardless of what actually
            // happened — a fabricated outcome. Say there is none.
            pill = softPill(t('disabled'), 'var(--anas-muted,gray)', t(DISABLED_RESULT_TIP));
        } else if (result === 'never-run') {
            // The enabled twin of F9: an enabled task IS referenced by its
            // timer, so systemd keeps its unit loaded — empty run timestamps
            // can only mean it has never fired, and the default-valued
            // Result=success was a fabricated success. Say so.
            pill = softPill(t('never run'), 'var(--anas-muted,gray)', t(NEVER_RUN_TIP));
        } else if (overdue) {
            pill = pillHtml(t('overdue'), 'var(--anas-danger,#c23b2c)',
                t('Past its schedule without a successful run — treated as failed.'));
        } else {
            pill = pillHtml(t('unknown'), 'var(--anas-muted,gray)', '');
        }
        var rel = at ? relTime(at) : '';
        if (rel) {
            pill += ' <span style="color:var(--anas-muted,gray);font-size:0.9em;">' + enc(rel) + '</span>';
        }
        return pill;
    }

    function renderNextRun(v, meta, rec) {
        var at = rec.get('nextRunAt');
        var overdue = rec.get('overdue') === true;
        if (!at) {
            return '<span style="color:gray;">&mdash;</span>';
        }
        var rel = relTime(at);
        var color = overdue ? 'var(--anas-danger,#c23b2c)' : '';
        return '<span title="' + enc(absTime(at)) + '"'
            + (color ? ' style="color:' + color + ';font-weight:600;"' : '') + '>'
            + enc(rel || absTime(at)) + '</span>';
    }

    function renderEnabled(v, meta, rec) {
        var on = !!rec.get('enabled');
        if (on) {
            return pillHtml(t('Enabled'), 'var(--anas-ok,#1f9c56)', '');
        }
        return '<span style="display:inline-block;padding:1px 9px;border-radius:9px;font-size:0.85em;'
            + 'color:var(--anas-muted,gray);'
            + 'background:color-mix(in srgb,var(--anas-muted,gray) 18%,transparent);">'
            + enc(t('Disabled')) + '</span>';
    }

    // ---- Repos: fetch + cache ----------------------------------------------

    // Normalise the repos payload (tolerate a bare array or the {version,repos}
    // envelope). Never rejects.
    function reposEnvelope(res) {
        var data = (res && res.data) || {};
        if (isArray(data)) {
            return { version: 0, repos: data };
        }
        return {
            version: (data.version === undefined || data.version === null) ? 0 : data.version,
            repos: data.repos || [],
        };
    }

    function repoRow(r) {
        r = r || {};
        return {
            name: r.name,
            host: r.host || '',
            port: r.port || PBS_PORT,
            datastore: r.datastore || '',
            namespace: first(r.namespace) || '',
            authType: ('' + (first(r.authType, r.auth) || 'token')).toLowerCase(),
            tokenId: first(r.tokenId, r.tokenid) || '',
            username: first(r.username, r.user) || '',
            credentialsSet: first(r.credentialsSet, r.credsSet) === true,
            fingerprint: first(r.fingerprint, r.certFingerprint) || '',
            // Tier: 'pve' = auto-discovered from storage.cfg (hands-off), else
            // 'anas' = registered. Drives the PVE badge + edit/delete lock-out.
            source: ('' + (first(r.source) || 'anas')).toLowerCase(),
            raw: r,
        };
    }

    // A tier-1 (PVE-defined) repo is hands-off: managed in Datacenter → Storage.
    function isPveRepo(rec) {
        try {
            return rec && ('' + (rec.get ? rec.get('source') : rec.source)) === 'pve';
        } catch (e) {
            return false;
        }
    }

    // Refresh REPO_MAP (name → {datastore,host,port}); returns the repos envelope.
    function loadReposInto(node) {
        return ANAS.api.get(node, '/backup/repos').then(function (res) {
            var env = reposEnvelope(res);
            var map = {};
            for (var i = 0; i < env.repos.length; i++) {
                var r = env.repos[i] || {};
                if (r.name) {
                    map[r.name] = {
                        datastore: r.datastore || '',
                        host: r.host || '',
                        port: r.port || PBS_PORT,
                        // The repo's OWN namespace — the task wizard falls back to
                        // it when a task sets no namespace, to verify the EFFECTIVE
                        // namespace at save time.
                        namespace: first(r.namespace) || '',
                    };
                }
            }
            REPO_MAP = map;
            return env;
        }, function (err) {
            ANAS.warn('backup repos load failed: ' + ANAS.errText(err));
            return { version: 0, repos: [] };
        });
    }

    // Resolve to [{name, label}] repo options for the task wizard picker.
    function loadRepoOptions(node) {
        return loadReposInto(node).then(function (env) {
            var opts = [];
            for (var i = 0; i < env.repos.length; i++) {
                var r = env.repos[i] || {};
                if (!r.name) {
                    continue;
                }
                var label = r.datastore ? (r.name + '  (' + r.datastore + ')') : r.name;
                // Badge tier-1 PVE-defined repos so the picker distinguishes them.
                if (('' + (r.source || 'anas')).toLowerCase() === 'pve') {
                    label += '  — ' + t('PVE');
                }
                // The repository's own namespace rides along (additive — a store
                // that does not declare it simply drops it): the restore dialog
                // pre-fills the namespace field from it for zero re-entry.
                opts.push({ name: r.name, label: label, namespace: r.namespace || '' });
            }
            return opts;
        });
    }

    // ---- Path-picker candidates (best-effort; free-typing always works) -----

    // Gather filesystem-path candidates from mounts + dataset mountpoints. Never
    // rejects; any failure just yields fewer candidates.
    function loadPathCandidates(node, store) {
        var seen = {};
        var rows = [];
        function add(path, note) {
            var p = trim(path);
            if (!p || p.charAt(0) !== '/' || seen[p]) {
                return;
            }
            seen[p] = true;
            rows.push({ path: p, label: note ? (p + '  (' + note + ')') : p });
        }
        function commit() {
            try {
                if (store && !store.destroyed) {
                    rows.sort(function (a, b) { return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0); });
                    store.loadData(rows);
                }
            } catch (e) {
                // non-fatal — the field stays free-text
            }
        }
        var mountsP = ANAS.api.get(node, '/mounts').then(function (res) {
            var list = (res && res.data) || [];
            for (var i = 0; i < list.length; i++) {
                add(list[i] && list[i].mountpoint, t('mount'));
            }
        }, function () { /* ignore */ });

        var dsP = ANAS.api.get(node, '/pools').then(function (res) {
            var pools = (res && res.data) || [];
            var subs = [];
            for (var i = 0; i < pools.length; i++) {
                (function (poolName) {
                    if (!poolName) {
                        return;
                    }
                    subs.push(ANAS.api.get(node, '/pools/' + encodeURIComponent(poolName) + '/datasets').then(
                        function (dres) {
                            var dsList = (dres && dres.data) || [];
                            for (var j = 0; j < dsList.length; j++) {
                                var mp = dsList[j] && dsList[j].mountpoint;
                                if (mp && mp !== 'none' && mp !== 'legacy') {
                                    add(mp, t('dataset'));
                                }
                            }
                        }, function () { /* ignore */ }));
                }(pools[i] && pools[i].name));
            }
            return Promise.all(subs);
        }, function () { /* ignore */ });

        Promise.all([mountsP, dsP]).then(commit, commit);
    }

    // ======================================================================
    //  Directory picker — the SHARED widget (12-picker.js)
    //
    //  The flat listbox this used to be is gone: story backup2.5 replaced it
    //  with PVE's expanding-tree idiom (breadcrumb, type-ahead, keyboard nav),
    //  and the same widget serves the restore flow against a PBS archive. This
    //  view keeps ONE responsibility — say which field the chosen path lands in.
    //
    //  Free-form typing in the wizard field is untouched and remains
    //  authoritative: the picker only fills the field in.
    // ======================================================================

    function openDirPicker(node, startPath, onSelect) {
        if (!ANAS.pathPicker) {
            // Fail-open: an older bundle without the picker must not break the
            // wizard — the path field still takes a typed path.
            ANAS.warn('path picker unavailable; type the path instead');
            return;
        }
        ANAS.pathPicker({
            node: node,
            backend: 'live',
            mode: 'dir',
            value: trim(startPath) || '/',
            title: t('Choose a directory'),
            onSelect: onSelect,
        });
    }

    // ---- LUN picker (backup2.4) --------------------------------------------
    //
    // The block-storage sibling of the directory picker, and exactly as
    // OPTIONAL: it fills the path field, and typing a device or image path by
    // hand keeps working. The list comes from GET /backup/lun-sources — the
    // iSCSI read layer, filtered to what ANAS can actually say something about
    // (no unresolvable backings, no PVE-owned volumes) and carrying each LUN's
    // DERIVED consistency, so the choice is informed before it is made.

    function lunConsistencyChip(rec) {
        var c = rec && rec.consistency;
        if (!c || typeof c !== 'object') {
            return '';
        }
        var snap = c.consistency === 'snapshot';
        if (!snap && c.consistency !== 'live') {
            return '';
        }
        return pillHtml(snap ? t('snapshot') : t('live'),
            snap ? 'var(--anas-ok,#1f9c56)' : 'var(--anas-muted,gray)',
            '' + (c.reason || ''));
    }

    function openLunPicker(node, onSelect) {
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-backup-lun-picker',
                title: t('Choose an iSCSI LUN'),
                modal: true,
                width: 720,
                height: 420,
                resizable: true,
                layout: { type: 'vbox', align: 'stretch' },
                items: [
                    {
                        xtype: 'component',
                        itemId: 'lunNote',
                        padding: '8 10 4 10',
                        html: '',
                    },
                    {
                        xtype: 'gridpanel',
                        itemId: 'lunGrid',
                        cls: 'anas-grid-backup-lun-picker',
                        flex: 1,
                        border: false,
                        store: Ext.create('Ext.data.Store', {
                            fields: ['targetIqn', 'index', 'name', 'kind', 'path', 'serial', 'size', 'backingExists', 'consistency'],
                            data: [],
                        }),
                        emptyText: t('No backup-eligible LUNs on this node'),
                        columns: [
                            {
                                text: t('Target'),
                                dataIndex: 'targetIqn',
                                flex: 2,
                                sortable: false,
                                menuDisabled: true,
                                // IQNs are never truncated (the ids rule).
                                renderer: function (v) { return '<span style="font-family:monospace;">' + enc(v) + '</span>'; },
                            },
                            {
                                text: t('LUN'),
                                dataIndex: 'index',
                                width: 60,
                                sortable: false,
                                menuDisabled: true,
                                // Raw store values never reach innerHTML (the
                                // same rule the Backup grid's Name column runs).
                                renderer: Ext.String.htmlEncode,
                            },
                            {
                                text: t('Name'),
                                dataIndex: 'name',
                                flex: 1,
                                sortable: false,
                                menuDisabled: true,
                                renderer: Ext.String.htmlEncode,
                            },
                            {
                                text: t('Backing'),
                                dataIndex: 'path',
                                flex: 2,
                                sortable: false,
                                menuDisabled: true,
                                renderer: function (v, meta, rec) {
                                    var kind = rec.get('kind') === 'zvol' ? t('ZFS volume') : t('image file');
                                    var size = rec.get('size');
                                    var sizeText = (typeof size === 'number' && size >= 0 && ANAS.formatBytes)
                                        ? ('  ' + ANAS.formatBytes(size))
                                        : '';
                                    // A backing object that does not resolve right
                                    // now is SHOWN and named — a row that quietly
                                    // vanished would explain nothing.
                                    var gone = rec.get('backingExists') === false
                                        ? '<span style="color:var(--anas-warn,#c9820b);"> — '
                                            + enc(t('the backing object does not resolve on this node right now'))
                                            + '</span>'
                                        : '';
                                    return '<span style="font-family:monospace;">' + enc(v) + '</span>'
                                        + '<span style="color:var(--anas-muted,gray);"> (' + enc(kind + sizeText) + ')</span>'
                                        + gone;
                                },
                            },
                            {
                                // The SCSI unit serial is the identity an
                                // initiator (and a PVE volid) pins — shown in
                                // full, never truncated.
                                text: t('Serial'),
                                dataIndex: 'serial',
                                flex: 1,
                                sortable: false,
                                menuDisabled: true,
                                renderer: function (v) {
                                    return v
                                        ? '<span style="font-family:monospace;">' + enc(v) + '</span>'
                                        : '<span style="color:var(--anas-muted,gray);">' + enc(t('not readable')) + '</span>';
                                },
                            },
                            {
                                text: t('Consistency'),
                                dataIndex: 'consistency',
                                width: 120,
                                sortable: false,
                                menuDisabled: true,
                                renderer: function (v, meta, rec) {
                                    return lunConsistencyChip({ consistency: rec.get('consistency') });
                                },
                            },
                        ],
                        listeners: {
                            itemdblclick: function (g, rec) {
                                selectLun(win, rec, onSelect);
                            },
                        },
                    },
                ],
                buttons: [
                    { text: t('Cancel'), handler: function () { win.close(); } },
                    {
                        text: t('Select'),
                        cls: 'anas-btn-backup-lun-select',
                        handler: function () {
                            var grid = win.down('#lunGrid');
                            var sel = grid ? grid.getSelection() : [];
                            if (!sel || !sel.length) {
                                return;
                            }
                            selectLun(win, sel[0], onSelect);
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('LUN picker window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
        loadLunSources(win, node);
    }

    function selectLun(win, rec, onSelect) {
        if (onSelect) {
            try {
                // The path + record are what a row-level pick records; the
                // serial, name and derived consistency ride along for the
                // block panel (backup2.9) — the row caller ignores the extras.
                onSelect({
                    targetIqn: '' + rec.get('targetIqn'),
                    index: rec.get('index'),
                    path: '' + rec.get('path'),
                    serial: (rec.get('serial') == null) ? null : ('' + rec.get('serial')),
                    name: '' + (rec.get('name') || ''),
                    consistency: rec.get('consistency') || null,
                });
            } catch (e) {
                ANAS.warn('LUN select failed: ' + ANAS.errText(e));
            }
        }
        win.close();
    }

    function lunNoteOut(win, html) {
        try {
            var out = win && win.down ? win.down('#lunNote') : null;
            if (out && !out.destroyed && !out.destroying) {
                out.update(html);
            }
        } catch (e) {
            ANAS.warn('LUN picker note render failed: ' + ANAS.errText(e));
        }
    }

    function loadLunSources(win, node) {
        var grid = win.down('#lunGrid');
        if (grid) {
            try { grid.setLoading(true); } catch (e) { /* non-fatal */ }
        }
        ANAS.api.get(node, '/backup/lun-sources').then(
            function (res) {
                if (win.destroyed || win.destroying) {
                    return;
                }
                if (grid) {
                    try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
                }
                var d = (res && res.data) || {};
                var rows = isArray(d.luns) ? d.luns : [];
                try { grid.getStore().loadData(rows); } catch (e2) { /* non-fatal */ }
                // "Not installed" is a first-class state, not an error: say it
                // plainly instead of showing an empty grid with no explanation.
                lunNoteOut(win, d.installed === false
                    ? ('<div style="font-size:11px;color:var(--anas-muted,gray);">'
                        + enc('' + (d.reason || t('This node does not serve iSCSI block storage.'))) + '</div>')
                    : '');
            },
            function (err) {
                if (win.destroyed || win.destroying) {
                    return;
                }
                if (grid) {
                    try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
                }
                lunNoteOut(win, '<div style="font-size:11px;color:var(--anas-muted,gray);">'
                    + enc(t('Could not list iSCSI LUNs') + ': ' + ANAS.errText(err)) + '</div>');
            }
        );
    }

    // ---- Block panel (backup2.9) -------------------------------------------
    //
    // A block task's whole shape: one LUN, picked through the same LUN picker
    // the archive rows use. The panel holds the pick's facts (name, target,
    // index, path, the derived consistency chip) and drives the two derived
    // identities — the fixed archive name and the `lun-<serial>` backup-id.
    // A stored pick (an edit, or a door's pre-fill) is RE-RESOLVED against the
    // node's LUN list: the name is display-only and read where it lives, and a
    // LUN that is gone is a state the panel shows, not a silent pre-fill.

    /**
     * Set the block panel's LUN. `fromPicker` marks a just-made pick — its
     * facts (incl. serial, name, consistency) are current, render straight
     * away. Otherwise the facts are re-resolved against `GET /backup/lun-sources`
     * (fail-open: an unanswered list keeps what is known, no chip).
     */
    function setBlockLun(win, lun, fromPicker) {
        try {
            if (!win || win.destroyed || win.destroying) {
                return;
            }
            win.anasBlockLun = {
                targetIqn: '' + (lun && lun.targetIqn ? lun.targetIqn : ''),
                index: lun && lun.index !== undefined && lun.index !== null ? lun.index : 0,
                path: '' + (lun && lun.path ? lun.path : ''),
                serial: (lun && lun.serial == null) ? null : ('' + lun.serial),
                name: '' + (lun && lun.name ? lun.name : ''),
            };
            win.anasBlockConsistency = (lun && lun.consistency) ? lun.consistency : null;
            win.anasBlockStale = false;
            if (fromPicker) {
                renderBlockLun(win);
                syncBlockIdValue(win);
                syncTaskKind(win);
                return;
            }
            loadBlockLunSources(win);
        } catch (e) {
            ANAS.warn('block LUN set failed: ' + ANAS.errText(e));
        }
    }

    /** Re-resolve the current pick against the node's LUN list (see above). */
    function loadBlockLunSources(win) {
        var node = win.anasNode;
        ANAS.api.get(node, '/backup/lun-sources').then(
            function (res) {
                if (win.destroyed || win.destroying) {
                    return;
                }
                var d = (res && res.data) || {};
                var luns = isArray(d.luns) ? d.luns : [];
                var seed = win.anasBlockLun;
                var match = null;
                var i;
                // The record is the truth; the path is the fallback (an edit
                // whose archive lost its record still names its source).
                if (seed && seed.targetIqn) {
                    for (i = 0; i < luns.length; i++) {
                        var l = luns[i] || {};
                        if (l.targetIqn === seed.targetIqn && Number(l.index) === Number(seed.index)) {
                            match = l;
                            break;
                        }
                    }
                }
                if (!match && seed && seed.path) {
                    for (i = 0; i < luns.length; i++) {
                        if ((luns[i] || {}).path === seed.path) {
                            match = luns[i];
                            break;
                        }
                    }
                }
                if (match) {
                    win.anasBlockLun = {
                        targetIqn: '' + match.targetIqn,
                        index: match.index,
                        path: '' + match.path,
                        serial: (match.serial == null) ? null : ('' + match.serial),
                        name: '' + (match.name || ''),
                    };
                    win.anasBlockConsistency = match.consistency || null;
                    win.anasBlockStale = false;
                } else if (seed && seed.path) {
                    // The list answered and does not hold the LUN: shown, amber.
                    win.anasBlockStale = true;
                }
                renderBlockLun(win);
                syncBlockIdValue(win);
                syncTaskKind(win);
            },
            function () {
                // Fail-open: the list could not answer — keep the known facts,
                // no chip, and no stale claim (we cannot say either way).
                if (win.destroyed || win.destroying) {
                    return;
                }
                win.anasBlockStale = false;
                renderBlockLun(win);
                syncBlockIdValue(win);
                syncTaskKind(win);
            }
        );
    }

    /** The picked LUN's facts on screen — or the "(no LUN chosen)" state. */
    function renderBlockLun(win) {
        try {
            if (!win || win.destroyed || win.destroying) {
                return;
            }
            var out = win.down('#blockLunOut');
            if (!out) {
                return;
            }
            var lun = win.anasBlockLun;
            if (!lun || !lun.path) {
                out.update('<div style="font-size:11px;color:var(--anas-muted,gray);">'
                    + enc(t('No LUN chosen.')) + '</div>');
                return;
            }
            var html = '<div style="font-size:12px;">'
                + '<i class="fa fa-hdd-o" style="margin-right:5px;color:var(--anas-muted,gray);"></i>'
                + enc(lun.name || t('unnamed LUN'))
                + ' <span style="color:var(--anas-muted,gray);">—</span> '
                + '<span style="font-family:monospace;" title="' + enc(t('Target IQN — never truncated')) + '">'
                + enc(lun.targetIqn) + '</span>'
                + ' <span style="color:var(--anas-muted,gray);">' + enc(t('LUN') + ' ' + lun.index) + '</span>';
            var chip = lunConsistencyChip({ consistency: win.anasBlockConsistency });
            if (chip) {
                html += ' ' + chip;
            }
            html += '</div>';
            html += '<div style="font-size:11px;color:var(--anas-muted,gray);margin-top:2px;">'
                + '<span style="font-family:monospace;">' + enc(lun.path) + '</span>'
                + (lun.serial
                    ? ' <span title="' + enc(t('SCSI unit serial — the backup-id derives from it')) + '"></span>'
                    : ' <span style="color:var(--anas-warn,#c9820b);">('
                        + enc(t('serial not readable')) + ')</span>')
                + '</div>';
            if (win.anasBlockStale === true) {
                html += '<div style="font-size:11px;color:var(--anas-warn,#c9820b);margin-top:2px;">'
                    + '<i class="fa fa-exclamation-triangle" style="margin-right:5px;"></i>'
                    + enc(t('This LUN is not in the node\'s LUN list right now — saving will be '
                        + 'refused until it resolves.'))
                    + '</div>';
            }
            out.update(html);
        } catch (e) {
            ANAS.warn('block LUN render failed: ' + ANAS.errText(e));
        }
    }

    /**
     * The block task's backup-id: on a NEW task with a readable serial it
     * DERIVES from the pick and goes read-only (the group IS the LUN). A
     * serial the read layer cannot read leaves the field open — the daemon
     * cannot verify an id it cannot read either, and a dead field would be the
     * only way to create the task. An EDIT shows the stored id, always
     * editable — the daemon's serial guard says what a stored-block id may
     * become (a guiding 400 names the required id).
     */
    function syncBlockIdValue(win) {
        try {
            var f = win && win.down ? win.down('#backupId') : null;
            if (!f) {
                return;
            }
            var lun = win.anasBlockLun;
            if (win.anasBlockNewId && lun && lun.serial) {
                f.setValue(lunBackupId(lun.serial));
            }
        } catch (e) {
            // the field stays as it was
        }
    }

    /**
     * The shape switch: which panel is on, and whether the id field is locked
     * (new block task + a readable serial). The change-detection fieldset is
     * part of the files shape — a block image has no mode to set.
     */
    function syncTaskKind(win) {
        try {
            if (!win || win.destroyed || win.destroying) {
                return;
            }
            var kind = win.anasTaskKind === 'block' ? 'block' : 'files';
            var files = win.down('#filesPanel');
            var block = win.down('#blockPanel');
            var modePanel = win.down('#modePanel');
            var group = win.down('#kindGroup');
            if (files) {
                files.setVisible(kind === 'files');
            }
            if (block) {
                block.setVisible(kind === 'block');
            }
            if (modePanel) {
                modePanel.setVisible(kind === 'files');
            }
            if (group) {
                group.setVisible(win.anasKindChoosable === true);
            }
            // A switch to the block shape must show its LUN state (fresh or
            // "(no LUN chosen)"), not a blank panel.
            if (kind === 'block') {
                renderBlockLun(win);
            }
            var f = win.down('#backupId');
            if (f && typeof f.setReadOnly === 'function') {
                f.setReadOnly(kind === 'block' && win.anasBlockNewId === true
                    && !!win.anasBlockLun && !!win.anasBlockLun.serial);
            }
        } catch (e) {
            // non-fatal: the panels stay as they are
        }
    }

    /**
     * The one archive a block task sends. A NEW task is the fixed shape: the
     * whole image under the fixed name, with the record of the LUN it was
     * picked as. An EDIT keeps its STORED name verbatim (existing archives are
     * never re-derived) and re-points only when a different LUN was picked —
     * a re-pick is a different source, and the record follows the path.
     */
    function readBlockArchive(win) {
        var lun = win.anasBlockLun;
        if (!lun || !lun.path) {
            return null;
        }
        if (!win.anasBlockStored) {
            return {
                name: BLOCK_ARCHIVE_NAME,
                path: lun.path,
                excludes: [],
                kind: 'img',
                lun: { targetIqn: lun.targetIqn, index: lun.index },
            };
        }
        var stored = win.anasBlockStored;
        var same = !!stored.lun
            && stored.lun.targetIqn === lun.targetIqn
            && Number(stored.lun.index) === Number(lun.index);
        return {
            name: stored.name || BLOCK_ARCHIVE_NAME,
            path: same ? stored.path : lun.path,
            excludes: [],
            kind: 'img',
            lun: same && stored.lun
                ? { targetIqn: stored.lun.targetIqn, index: stored.lun.index }
                : { targetIqn: lun.targetIqn, index: lun.index },
        };
    }

    // CAS-aware repo writes go through the shared ANAS.casWrite (10-api.js) —
    // the same registry-conflict discipline the replication remotes use.

    // ======================================================================
    //  Task grid load / reload
    // ======================================================================

    function gridOf(view) {
        try {
            return view ? view.down('#backupGrid') : null;
        } catch (e) {
            return null;
        }
    }

    function selectedTask(grid) {
        var sel = grid ? grid.getSelection() : [];
        return (sel && sel.length) ? sel[0] : null;
    }

    // `quiet` skips the grid loading mask — the timed poll refreshes in place
    // with no visible flash; initial render and manual Reload keep the mask.
    function loadTasks(view, node, quiet) {
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
        var priorSel = selectedTask(grid);
        var priorName = priorSel ? priorSel.get('name') : null;

        // Refresh the repo map first so the datastore column can resolve, then
        // load the tasks. Both are fail-open.
        loadReposInto(node).then(function () {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            ANAS.api.get(node, '/backup/tasks').then(function (res) {
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
                    rows.push(taskRow(list[i]));
                }
                // loadData fires a transient empty selectionchange — guard so the
                // detail panel does not blank during a poll refresh (mounts fix).
                grid.anasReloading = true;
                try {
                    grid.getStore().loadData(rows);
                } catch (e2) {
                    ANAS.warn('backup grid load failed: ' + ANAS.errText(e2));
                }
                if (priorName) {
                    try {
                        var store = grid.getStore();
                        var idx = store.findExact('name', priorName);
                        if (idx >= 0) {
                            grid.getSelectionModel().select(idx, false, true);
                        }
                    } catch (eSel) {
                        // non-fatal
                    }
                }
                grid.anasReloading = false;
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
                ANAS.warn('backup tasks load failed: ' + ANAS.errText(err));
            });
        });
    }

    ANAS.backup = ANAS.backup || {};
    ANAS.backup.reload = loadTasks;
    // The second doors (a door opens the EXISTING dialog, never a second
    // implementation): the iSCSI LUN toolbar (75-iscsi.js) reaches in here.
    // runTaskNow is the Backup menu's Run Now on a task name; openEditTask is
    // its Edit — the task object is exactly what the menu's grid record
    // carries as `raw`; openNewTask is its New Task with pre-filled archive
    // rows.
    ANAS.backup.runTaskNow = function (node, name, view) {
        runTaskByName(view, node, name);
    };
    ANAS.backup.openEditTask = function (view, node, task, onDone) {
        openTaskDialog(view, node, task, null, null, onDone);
    };
    // `preset` (backup2.9) is `{ kind: 'block', lun: { targetIqn, index, path,
    // serial?, name? } }`: the LUN toolbar's door opens the wizard with the
    // block panel ALREADY CHOSEN (the kind choice is skipped) and its LUN
    // pre-selected. `seedArchives` stays for a plain files seed. `onDone`
    // (both doors) fires once after the task save completes successfully —
    // the iSCSI LUNs window re-reads its backup coverage through it, so its
    // badges are not one task behind the wizard's own Create/Edit doors.
    ANAS.backup.openNewTask = function (view, node, seedArchives, preset, onDone) {
        openTaskDialog(view, node, null, seedArchives, preset, onDone);
    };

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

    function updateButtons(grid) {
        var rec = selectedTask(grid);
        var has = !!rec;
        setDisabled(grid, 'backupRun', !has);
        // A restore is allowed for a DISABLED task too — disabling the backups
        // must not take the restore path away with it.
        setDisabled(grid, 'backupRestore', !has);
        setDisabled(grid, 'backupDetails', !has);
        setDisabled(grid, 'backupEdit', !has);
        setDisabled(grid, 'backupToggle', !has);
        setDisabled(grid, 'backupDelete', !has);
        try {
            var toggle = grid.down('#backupToggle');
            if (toggle) {
                var on = has && rec.get('enabled');
                toggle.setText(on ? t('Disable') : t('Enable'));
                toggle.setIconCls(on ? 'fa fa-pause' : 'fa fa-play');
            }
        } catch (e) {
            // non-fatal
        }
    }

    // ======================================================================
    //  Detail — LOCAL-ONLY (config + units + recent journald; no PBS). Shown
    //  on demand in a window (the Details button), not a docked panel: the grid
    //  owns the full height. The window is an open-on-demand snapshot — its
    //  Reload button is the only refresh; it never polls.
    // ======================================================================

    function kv(label, value) {
        return '<tr><td style="padding:2px 14px 2px 0;color:var(--anas-muted,gray);'
            + 'white-space:nowrap;vertical-align:top;">' + enc(label)
            + '</td><td style="padding:2px 0;">' + value + '</td></tr>';
    }

    function mono(s) {
        return '<span style="font-family:monospace;font-size:0.92em;word-break:break-all;">'
            + enc(s) + '</span>';
    }

    function unitBlock(title, text) {
        if (!text) {
            return '';
        }
        return '<div style="margin-top:10px;">'
            + '<div style="color:var(--anas-muted,gray);font-size:0.85em;margin-bottom:3px;">'
            + enc(title) + '</div>'
            + '<pre style="margin:0;padding:8px 10px;border-radius:6px;overflow-x:auto;'
            + 'background:rgba(127,127,127,0.10);font-size:12px;white-space:pre;">'
            + enc(text) + '</pre></div>';
    }

    // The scan the daemon ran for THIS archive, matched by name then by path
    // (a task written before backup2.2 has no per-archive key to match on).
    function nestedScanFor(scans, archive) {
        if (!isArray(scans)) {
            return null;
        }
        for (var i = 0; i < scans.length; i++) {
            var s = scans[i] || {};
            if (s.archive && archive.name && s.archive === archive.name) {
                return s;
            }
        }
        for (var j = 0; j < scans.length; j++) {
            if ((scans[j] || {}).path === archive.path) {
                return scans[j];
            }
        }
        return null;
    }

    /**
     * The per-archive nested summary line for the detail window (backup2.2).
     *
     * `pending` / `errText` (backup2 fix-ups): the detail no longer carries the
     * boundary scan — the window loads it progressively through
     * preview-nested. While that request is in flight the row shows a spinner
     * (muted), and if it fails a muted "unavailable" line with the error — the
     * rest of the detail is never touched by either state. Image archives never
     * pass these (an image has no boundaries; imageDetailHtml is unchanged).
     */
    function nestedDetailHtml(archive, scan, pending, errText) {
        var choice = nestedChoiceOf(archive);
        var label = choice === 'all'
            ? t('nested filesystems: all')
            : (isArray(choice)
                ? (t('nested filesystems') + ': ' + choice.join('  '))
                : t('nested filesystems: none'));
        var out = '';
        // backup2.3 — the DERIVED consistency, read-only, with the daemon's own
        // reason as the tooltip. First line: it frames everything below it.
        var chip = consistencyChipHtml(scan);
        if (chip) {
            var expansion = expansionLineHtml(scan);
            out += '<div style="margin-top:3px;">' + chip
                + (expansion
                    ? '<span style="color:var(--anas-muted,gray);margin-left:6px;">' + expansion + '</span>'
                    : '')
                + '</div>';
        }
        out += '<div style="color:var(--anas-muted,gray);margin-top:2px;">' + enc(label) + '</div>';
        // The progressive scan's two in-between states — in place of the nested
        // list, muted: a spinner while preview-nested is in flight, and the
        // honest error if it does not come back. The label above (the task's
        // own choice) stays, because it is a fact about the task, not the scan.
        if (pending) {
            if (errText) {
                out += '<div style="color:var(--anas-muted,gray);margin-top:3px;">'
                    + enc(t('Nested-filesystem scan unavailable') + ': ' + errText) + '</div>';
            } else {
                out += '<div style="color:var(--anas-muted,gray);margin-top:3px;">'
                    + '<i class="fa fa-refresh fa-spin" style="margin-right:6px;"></i>'
                    + enc(t('Scanning for nested filesystems…')) + '</div>';
            }
            return out;
        }
        if (!scan) {
            return out;
        }
        var excluded = excludedNested(scan);
        var found = isArray(scan.nested) ? scan.nested : [];
        if (excluded.length) {
            var names = [];
            for (var e = 0; e < excluded.length; e++) {
                names.push((excluded[e].path || '') + ' (' + nestedKindLabel(excluded[e].kind) + ')');
            }
            out += '<div style="margin-top:3px;">'
                + pillHtml(excluded.length + ' ' + t('excluded'), 'var(--anas-warn,#c9820b)',
                    t('backed up as empty directories') + ': ' + names.join(', '))
                + '<span style="color:var(--anas-muted,gray);margin-left:6px;">'
                + enc(t('backed up as empty directories')) + '</span></div>';
        }
        // Every nested filesystem under the source, with its kind — included or
        // not. What is there is never hidden just because it is covered.
        for (var i = 0; i < found.length; i++) {
            var n = found[i] || {};
            var on = n.included === true;
            out += '<div style="margin-left:2px;color:'
                + (on ? 'var(--anas-muted,gray)' : 'var(--anas-warn,#c9820b)') + ';">'
                + '<span style="font-family:monospace;">' + enc(n.path || '') + '</span> ('
                + enc(nestedKindLabel(n.kind)) + ') — '
                + enc(on ? t('included') : t('stored as an empty directory')) + '</div>';
        }
        if (scan.truncated === true) {
            out += '<div style="color:var(--anas-muted,gray);margin-top:2px;">'
                + enc(t('The boundary scan did not finish — there may be more than listed.')) + '</div>';
        }
        return out;
    }

    /**
     * The per-archive detail for a BLOCK IMAGE (backup2.4). It says three things
     * a file archive's block never has to: the kind, the LUN identity when the
     * source was picked as one, and the two facts about how an image is read.
     * There is no nested-filesystem line — an image has none.
     */
    function imageDetailHtml(archive, scan) {
        var out = '';
        var chip = consistencyChipHtml(scan);
        if (chip) {
            out += '<div style="margin-top:3px;">' + chip + '</div>';
        }
        out += '<div style="color:var(--anas-muted,gray);margin-top:2px;">'
            + enc(t('block image — every run reads the full image; the change-detection mode does not apply'))
            + '</div>';
        var lun = lunRefOf(archive);
        if (lun) {
            out += '<div style="color:var(--anas-muted,gray);margin-top:2px;">'
                + enc(t('iSCSI LUN') + ': ')
                + '<span style="font-family:monospace;">' + enc(lunLabel(lun)) + '</span></div>';
        }
        return out;
    }

    /**
     * The archives block's content — the title plus the per-archive table. ONE
     * renderer for the block at every stage of the progressive scan (spinner,
     * filled, failed), so the window re-rendering it alone cannot drift from
     * the first paint. `pending`/`errText` reach the files-kind rows only.
     */
    function archivesInnerHtml(task, scans, pending, errText) {
        var archives = archivesOf(task);
        if (!archives.length) {
            return '<div style="margin-top:10px;color:var(--anas-muted,gray);font-size:0.9em;">'
                + enc(t('No archives configured.')) + '</div>';
        }
        var html = '<div style="margin-top:10px;">'
            + '<div style="color:var(--anas-muted,gray);font-size:0.85em;margin-bottom:3px;">'
            + enc(t('Archives')) + '</div>';
        html += '<table style="border-collapse:collapse;width:100%;font-size:12px;">';
        for (var i = 0; i < archives.length; i++) {
            var a = archives[i];
            // backup2.4 — the archive's real name on the server carries its kind.
            var img = archiveKindOf(a) === 'img';
            var name = (a.name || '') + (img ? '.img' : '.pxar');
            var excl = (a.excludes && a.excludes.length)
                ? '<div style="color:var(--anas-muted,gray);margin-top:2px;">'
                    + enc(t('excludes') + ': ' + a.excludes.join('  ')) + '</div>'
                : '';
            html += '<tr><td style="padding:3px 12px 3px 0;vertical-align:top;font-family:monospace;'
                + 'white-space:nowrap;color:var(--anas-accent,#3468c0);">' + enc(name) + '</td>'
                + '<td style="padding:3px 0;">' + mono(a.path) + excl
                + (img
                    ? imageDetailHtml(a, nestedScanFor(scans, a))
                    : nestedDetailHtml(a, nestedScanFor(scans, a), pending, errText))
                + '</td></tr>';
        }
        html += '</table></div>';
        return html;
    }

    /**
     * The archives block in the detail window, inside its STABLE wrapper. The
     * detail GET is instant (no scan in it), so the window re-renders this
     * block alone when the progressive preview-nested scan lands or fails —
     * the wrapper id is the handle that keeps the rest of the detail (units,
     * journald) untouched.
     */
    function archivesBlock(task, scans, pending, errText) {
        return '<div id="anas-backup-detail-archives">'
            + archivesInnerHtml(task, scans, pending, errText) + '</div>';
    }

    // ---- Last run: snapshots + expansion (backup2.3) -----------------------
    //
    // journald is FORENSICS, never correctness (standing ruling) — so this block
    // is derived from the recent-runs text the detail already carries and is
    // labeled as recent-only, exactly like the block below it. Nothing is stored
    // to make it: the run writes these two progress lines, and if journald has
    // rotated them away the block is simply absent.

    /** `snapshotting <target> as/@ <label>` — one line per transient snapshot. */
    var RUN_SNAPSHOT_RE = /^\s*snapshotting\s+(.+)$/;
    /** `archive '<name>' <- <root>` — one line per expanded archive root. */
    var RUN_ARCHIVE_RE = /^\s*archive '([^']+)' <- (.+)$/;

    /** Every recent-run output blob the detail carries, newest first. */
    function runOutputs(d) {
        var out = [];
        var runs = first(d.recentRuns, d.runs);
        if (isArray(runs)) {
            for (var i = 0; i < runs.length; i++) {
                if (runs[i] && runs[i].output) {
                    out.push('' + runs[i].output);
                }
            }
        }
        var journal = first(d.journal, d.recentOutput);
        if (!out.length && journal) {
            out.push('' + journal);
        }
        return out;
    }

    /**
     * The suffix a run-log archive name should be shown with. journald's line is
     * `archive '<name>' <- <root>` and carries no kind, so it is looked up in the
     * task's OWN archives by exact name — a derived child (`<name>__<child>`) is
     * always a file archive, and an unknown name degrades to `.pxar` rather than
     * guessing from the root path.
     */
    function runArchiveSuffix(task, name) {
        var archives = archivesOf(task);
        for (var i = 0; i < archives.length; i++) {
            if (archives[i].name === name) {
                return archiveKindOf(archives[i]) === 'img' ? '.img' : '.pxar';
            }
        }
        return '.pxar';
    }

    function lastRunSnapshotBlock(d) {
        var blobs = runOutputs(d);
        var snapshots = [];
        var roots = [];
        for (var b = 0; b < blobs.length && !snapshots.length && !roots.length; b++) {
            var lines = ('' + blobs[b]).split('\n');
            for (var i = 0; i < lines.length; i++) {
                var arch = RUN_ARCHIVE_RE.exec(lines[i]);
                if (arch) {
                    roots.push({ name: arch[1], root: arch[2] });
                    continue;
                }
                var snap = RUN_SNAPSHOT_RE.exec(lines[i]);
                if (snap) {
                    snapshots.push(trim(snap[1]));
                }
            }
        }
        if (!snapshots.length && !roots.length) {
            return '';
        }
        var html = '<div style="margin-top:12px;">'
            + '<div style="color:var(--anas-muted,gray);font-size:0.85em;margin-bottom:3px;">'
            + '<i class="fa fa-camera" style="margin-right:5px;"></i>'
            + enc(t('Last run: snapshot + archive roots (from journald — recent only)')) + '</div>';
        for (var s = 0; s < snapshots.length; s++) {
            html += '<div style="font-size:12px;font-family:monospace;">' + enc(snapshots[s]) + '</div>';
        }
        for (var r = 0; r < roots.length; r++) {
            html += '<div style="font-size:12px;">'
                + '<span style="font-family:monospace;color:var(--anas-accent,#3468c0);">'
                + enc(roots[r].name + runArchiveSuffix(d.task || d, roots[r].name)) + '</span>'
                + '<span style="color:var(--anas-muted,gray);"> ← </span>'
                + '<span style="font-family:monospace;">' + enc(roots[r].root) + '</span></div>';
        }
        return html + '</div>';
    }

    // The last-run row. It exists for the cases with NO result to show: a
    // DISABLED task whose run history systemd has garbage-collected (live-proof
    // F9), and an ENABLED task that has never run (its enabled twin). The
    // detail must say that in words rather than leave the grid's pill to carry
    // it alone. Nothing is shown for any other status — the grid already has
    // it, and a second copy would be clutter.
    function lastRunRow(d) {
        var result = '' + (d.lastRunResult || '');
        if (result === 'disabled') {
            var note = d.statusNote || DISABLED_HISTORY_SENTENCE;
        return kv(t('Last run'),
            softPill(t('disabled'), 'var(--anas-muted,gray)', t(DISABLED_RESULT_TIP))
            + ' <span style="color:var(--anas-muted,gray);">' + enc('\u2014 ' + note) + '</span>');
        }
        if (result === 'never-run') {
            return kv(t('Last run'), softPill(t('never run'), 'var(--anas-muted,gray)', t(NEVER_RUN_TIP)));
        }
        return '';
    }

    function recentRunsBlock(d) {
        var runs = first(d.recentRuns, d.runs);
        var journal = first(d.journal, d.recentOutput);
        if (!isArray(runs) && !journal) {
            return '';
        }
        var head = '<div style="margin-top:12px;">'
            + '<div style="color:var(--anas-muted,gray);font-size:0.85em;margin-bottom:3px;">'
            + '<i class="fa fa-history" style="margin-right:5px;"></i>'
            + enc(t('Recent runs (journald) — older history is not retained')) + '</div>';
        var body = '';
        if (isArray(runs) && runs.length) {
            body += '<table style="border-collapse:collapse;width:100%;font-size:12px;">';
            for (var i = 0; i < runs.length; i++) {
                var r = runs[i] || {};
                var res = '' + (first(r.result, r.status) || 'unknown');
                var color = res === 'success' ? 'var(--anas-ok,#1f9c56)'
                    : (res === 'failure' ? 'var(--anas-danger,#c23b2c)' : 'var(--anas-muted,gray)');
                var when = first(r.at, r.time, r.timestamp);
                var code = (r.exitCode !== undefined && r.exitCode !== null)
                    ? ' <span style="color:var(--anas-muted,gray);">(' + enc(t('exit') + ' ' + r.exitCode) + ')</span>'
                    : '';
                body += '<tr><td style="padding:2px 10px 2px 0;white-space:nowrap;">'
                    + '<span style="color:' + color + ';font-weight:600;">' + enc(res) + '</span>' + code + '</td>'
                    + '<td style="padding:2px 0;color:var(--anas-muted,gray);white-space:nowrap;">'
                    + enc(when ? absTime(when) : '') + '</td></tr>';
                if (r.output) {
                    body += '<tr><td colspan="2" style="padding:0 0 6px;">'
                        + '<pre style="margin:2px 0 0;padding:6px 8px;border-radius:6px;overflow-x:auto;'
                        + 'background:rgba(127,127,127,0.10);font-size:11px;white-space:pre-wrap;">'
                        + enc(r.output) + '</pre></td></tr>';
                }
            }
            body += '</table>';
        } else if (journal) {
            body += '<pre style="margin:0;padding:8px 10px;border-radius:6px;overflow-x:auto;'
                + 'background:rgba(127,127,127,0.10);font-size:11px;white-space:pre-wrap;">'
                + enc(journal) + '</pre>';
        } else {
            body += '<div style="color:var(--anas-muted,gray);font-size:0.9em;">'
                + enc(t('No recent runs recorded.')) + '</div>';
        }
        return head + body + '</div>';
    }

    // A link to the PBS web UI for server-side truth (snapshot history, verify
    // state, retention). ANAS never fetches this — the browser navigates.
    function pbsLinkBlock(task) {
        var repo = REPO_MAP[repoNameOf(task)];
        var host = repo && repo.host;
        var url = host ? ('https://' + host + ':' + (repo.port || PBS_PORT) + '/') : '';
        var msg = t('Snapshot history, sizes, and verification state live on the PBS server. '
            + 'ANAS never reads them — open the PBS web UI for server-side truth.');
        var link = url
            ? ' <a href="' + enc(url) + '" target="_blank" rel="noopener noreferrer">'
                + enc(t('Open PBS web UI')) + '</a>'
            : '';
        return '<div style="margin-top:12px;padding:8px 10px;border-radius:6px;'
            + 'background:rgba(52,104,192,0.08);font-size:12px;color:var(--anas-muted,gray);">'
            + '<i class="fa fa-external-link" style="margin-right:5px;"></i>'
            + enc(msg) + link + '</div>';
    }

    // The schedule as the detail shows it: the cadence in words with the generated
    // OnCalendar underneath (config-is-the-API transparency — the operator sees
    // exactly what the timer got), or just the expression for a raw-schedule task.
    function scheduleDetailHtml(task) {
        var expr = task && task.schedule
            ? '<span style="font-family:monospace;font-size:0.92em;">' + enc(task.schedule) + '</span>'
            : '<span style="color:gray;">&mdash;</span>';
        var text = cadenceText(cadenceOf(task));
        if (!text) {
            return expr;
        }
        var note = cadenceOf(task).kind === 'biweekly'
            ? '<div style="color:var(--anas-muted,gray);font-size:0.85em;">'
                + enc(t('The timer fires weekly; ANAS skips the off weeks (systemd calendars '
                    + 'cannot express "every other week"). A missed period heals on the next fire.'))
                + '</div>'
            : '';
        return enc(text) + '<div style="color:var(--anas-muted,gray);font-size:0.85em;">'
            + 'OnCalendar: ' + expr + '</div>' + note;
    }

    // The detail's Retention row: the configured keeps, or the honest statement
    // that ANAS prunes nothing and retention stays PBS-side (the default).
    function retentionRowHtml(task) {
        var keeps = retentionOf(task);
        if (!hasKeeps(keeps)) {
            return '<span style="color:var(--anas-muted,gray);">'
                + enc(t('none — ANAS never prunes this group (retention stays PBS-side)')) + '</span>';
        }
        return '<span style="font-family:monospace;font-size:0.92em;">' + enc(retentionSummary(keeps)) + '</span>'
            + ' <span style="color:var(--anas-muted,gray);font-size:0.9em;">'
            + enc(t('— pruned after each successful backup; garbage collection stays PBS-side'))
            + '</span>';
    }

    // The detail's Notifications row: which runs mail, in the words the wizard
    // uses. Delivery itself is PVE's — the matchers and targets live there.
    function notifyRowHtml(task) {
        var mode = notifyOf(task);
        var text = mode === 'on-failure'
            ? t('on failure — only a failed run, or one that completed with warnings, notifies')
            : t('always — every run that happened notifies (a skipped off week never does)');
        return enc(text) + ' <span style="color:var(--anas-muted,gray);font-size:0.9em;">'
            + enc(t('— delivered by the Proxmox notification system (type anas-backup)')) + '</span>';
    }

    function taskDetailHtml(d, pending, errText) {
        if (!d) {
            return '<div style="padding:12px 14px;color:var(--anas-danger,#c23b2c);">'
                + enc(t('No detail returned for this task.')) + '</div>';
        }
        var task = d.task || d;
        var repoName = repoNameOf(task);
        var ds = datastoreOf(task);
        var ns = first(task.namespace) || '';
        var repoText = enc(repoName) + (ds ? (':' + enc(ds)) : '') + (ns ? (' / ' + enc(ns)) : '');
        var mode = modeOf(task);
        var modeLabel = mode === 'metadata' ? t('Metadata') : t('Default (data/block)');
        // backup2.9 — the effective kind, with the legacy shape named when a
        // derived files task still carries image archive(s).
        var effKind = taskKindOf(task);
        var kindLabel = effKind.kind === 'block'
            ? '<span style="color:var(--anas-accent,#3468c0);">'
                + enc(t('block — one iSCSI LUN')) + '</span>'
            : enc(t('files'));
        if (effKind.legacyImgArchives) {
            kindLabel += ' <span style="color:var(--anas-warn,#c9820b);font-size:0.9em;">'
                + enc(t('— still carries image archive(s) from before block tasks existed'))
                + '</span>';
        }

        var rows = ''
            + kv(t('Task'), mono(task.name))
            + kv(t('Repository'), '<span style="font-family:monospace;font-size:0.92em;">' + repoText + '</span>')
            + kv(t('Backup ID'), mono('host/' + backupIdOf(task)))
            + kv(t('Kind'), kindLabel)
            + kv(t('Change detection'), enc(modeLabel))
            + kv(t('Retention'), retentionRowHtml(task))
            + kv(t('Notifications'), notifyRowHtml(task))
            + kv(t('Schedule'), scheduleDetailHtml(task))
            + kv(t('Enabled'), task.enabled !== false
                ? '<span style="color:var(--anas-ok,#1f9c56);">' + enc(t('yes')) + '</span>'
                : '<span style="color:var(--anas-muted,gray);">' + enc(t('no')) + '</span>')
            + lastRunRow(d);

        var html = '<div style="padding:10px 14px;">'
            + '<table style="border-collapse:collapse;width:100%;">' + rows + '</table>';
        // The last run's NOTES (backup2 fix-ups): the run's completion toast
        // points the operator here when it did not open a modal (notes without
        // warnings), so they must be findable on this window. Muted — they are
        // information about a deliberate choice, never a warning.
        var runNotices = isArray(d.lastRunNotices) ? d.lastRunNotices : [];
        if (runNotices.length) {
            html += '<div style="margin-top:8px;color:var(--anas-muted,gray);">'
                + enc(t('Notes')) + ': ' + ANAS.warningsHtml(runNotices) + '</div>';
        }
        // `pending`/`errText` are the progressive scan's states (the detail GET
        // itself no longer carries the boundary scan — see loadDetailInto).
        html += archivesBlock(task, d.nested, pending, errText);
        // The unit + timer, verbatim — config-is-the-API transparency (Principle 13).
        html += unitBlock(t('systemd service unit (as written)'), first(d.unit, d.serviceUnit));
        html += unitBlock(t('systemd timer (as written)'), first(d.timer, d.timerUnit));
        html += lastRunSnapshotBlock(d);
        html += recentRunsBlock(d);
        html += pbsLinkBlock(task);
        html += '</div>';
        return html;
    }

    // Does this detail still need its boundary scan loaded? The detail GET no
    // longer carries it (it is instant by design), so the answer is: the task
    // has at least one FILES archive (an image has no boundaries — it never
    // shows the spinner), and the detail did not already arrive with scans (an
    // older daemon that predates the split still serves them in the detail —
    // render those, do not re-fetch).
    function detailNeedsNestedScan(detail) {
        if (!detail) {
            return false;
        }
        if (isArray(detail.nested)) {
            return false;
        }
        var archives = archivesOf(detail.task || detail);
        for (var i = 0; i < archives.length; i++) {
            if (archiveKindOf(archives[i]) !== 'img') {
                return true;
            }
        }
        return false;
    }

    // Re-render ONLY the archives block of an open detail window, from the
    // window's stored detail. `errText` set = the scan failed (the muted
    // "unavailable" line replaces the spinners); absent = the scan landed
    // (win._detail.nested holds it). The stable wrapper keeps the rest of the
    // detail — units, journald, the PBS link — untouched; where the wrapper
    // cannot be reached the whole body is re-rendered from the same stored
    // detail (one renderer, no drift).
    function redrawDetailArchives(win, body, errText) {
        var detail = win && win._detail;
        if (!detail || !body || body.destroyed || body.destroying) {
            return;
        }
        var task = detail.task || detail;
        // The scan has LANDED either way (its data is on the stored detail when
        // it succeeded): the only "pending" here is the failed one, where the
        // muted error line takes the spinners' place.
        var failed = errText !== undefined && errText !== null;
        var el = body.getEl && body.getEl();
        var dom = el && el.dom;
        if (dom && dom.querySelector) {
            var wrap = dom.querySelector('#anas-backup-detail-archives');
            if (wrap) {
                wrap.innerHTML = archivesInnerHtml(task, detail.nested, failed, errText);
                return;
            }
        }
        try {
            body.update(taskDetailHtml(detail, failed, errText));
        } catch (e) {
            ANAS.warn('backup detail archives re-render failed: ' + ANAS.errText(e));
        }
    }

    // STAGE 2 of the detail: the boundary scan the window loads progressively
    // through preview-nested, on the SAME node. The detail GET is instant on
    // purpose — a scan in it is what hung a source rooted on a remote mount
    // until the gateway's 15 s forward tore the request down; the scan's own
    // 10 s budget (daemon-side) fits under that forward. The request body is
    // the task's archives, only the keys the endpoint's schema accepts. Every
    // callback is guarded exactly like loadDetailInto's: a closed window must
    // not be written to. The endpoint is archive-shaped (the task's own
    // archives are the request body), so the task name plays no part in it.
    function loadDetailNested(win, node) {
        var detail = win && win._detail;
        if (!detail || !detailNeedsNestedScan(detail)) {
            return;
        }
        var body = win.down('#detailBody');
        if (!body) {
            return;
        }
        var task = detail.task || detail;
        var archives = archivesOf(task);
        var reqArchives = [];
        for (var i = 0; i < archives.length; i++) {
            var a = archives[i] || {};
            var entry = {};
            if (a.name) {
                entry.name = a.name;
            }
            entry.path = a.path;
            if (a.includeNested !== undefined && a.includeNested !== null) {
                entry.includeNested = a.includeNested;
            }
            if (a.kind) {
                entry.kind = a.kind;
            }
            reqArchives.push(entry);
        }
        ANAS.api.post(node, '/backup/tasks/preview-nested', { archives: reqArchives }).then(function (res) {
            if (!win || win.destroyed || win.destroying) {
                return;
            }
            var scans = res && res.data && isArray(res.data.archives) ? res.data.archives : null;
            if (!scans) {
                return;
            }
            // The scan lands on the stored detail — the Restore door and any
            // later reload read it from there — and only the block re-renders.
            win._detail.nested = scans;
            redrawDetailArchives(win, body);
        }, function (err) {
            if (!win || win.destroyed || win.destroying) {
                return;
            }
            // The scan is unavailable: say so on the archive rows (muted) and
            // leave the rest of the detail exactly as it is.
            redrawDetailArchives(win, body, ANAS.errText(err));
        });
    }

    // Fetch GET /backup/tasks/:name and render it into the detail window's
    // body (STAGE 1 — instant: the boundary scan is not part of it). STAGE 2
    // (the scan itself) follows through preview-nested. Called on open and by
    // the window's Reload button — which repeats BOTH stages. No polling.
    function loadDetailInto(win, node, name) {
        if (!win || win.destroyed || win.destroying) {
            return;
        }
        var body = win.down('#detailBody');
        if (!body) {
            return;
        }
        body.update('<div style="padding:12px 14px;color:var(--anas-muted,gray);">'
            + '<i class="fa fa-refresh fa-spin" style="margin-right:6px;"></i>'
            + enc(t('loading…')) + '</div>');
        ANAS.api.get(node, '/backup/tasks/' + encodeURIComponent(name)).then(function (res) {
            if (body.destroyed || body.destroying) {
                return;
            }
            // The Restore door lives on this window and needs the same facts
            // the body just rendered: which repository, which namespace, and
            // where each archive's live home is.
            win._detail = (res && res.data) || null;
            try {
                // While stage 2 is about to start, the files rows show their
                // spinner instead of a nested list.
                body.update(taskDetailHtml(res && res.data, detailNeedsNestedScan(res && res.data)));
            } catch (e) {
                ANAS.warn('backup detail render failed: ' + ANAS.errText(e));
            }
            try {
                var restoreBtn = win.down('#backupDetailRestore');
                if (restoreBtn) {
                    restoreBtn.setDisabled(!win._detail);
                }
            } catch (e2) {
                // non-fatal
            }
            loadDetailNested(win, node);
        }, function (err) {
            if (body.destroyed || body.destroying) {
                return;
            }
            ANAS.warn('backup detail load failed: ' + ANAS.errText(err));
            body.update('<div style="padding:12px 14px;color:var(--anas-danger,#c23b2c);">'
                + enc(t('Failed to load detail') + ': ' + ANAS.errText(err)) + '</div>');
        });
    }

    // Open the on-demand Details window (modal:false, sized like the repos
    // manager). Snapshot semantics: it fetches once on open; the Reload button
    // is the refresh.
    function openTaskDetailWindow(node, name, view) {
        if (!name) {
            return;
        }
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-backup-detail',
                title: t('Backup Task') + ': ' + name,
                modal: false,
                width: 760,
                height: 520,
                resizable: true,
                layout: 'fit',
                items: [{
                    xtype: 'panel',
                    itemId: 'detailBody',
                    cls: 'anas-backup-detail',
                    border: false,
                    scrollable: true,
                    html: '',
                }],
                buttons: [
                    {
                        // The TASK-BOUND restore door (backup2.6). It opens on
                        // this task's own repository, namespace and group, so
                        // the operator picks a point in time and some files and
                        // nothing else. Disabled until the detail has loaded —
                        // the archive homes come from it.
                        text: t('Restore…'),
                        itemId: 'backupDetailRestore',
                        cls: 'anas-btn-backup-detail-restore',
                        iconCls: 'fa fa-undo',
                        disabled: true,
                        handler: function () { openRestoreFromDetail(win, node, name); },
                    },
                    {
                        text: t('Reload'),
                        cls: 'anas-btn-backup-detail-reload',
                        iconCls: 'fa fa-refresh',
                        handler: function () { loadDetailInto(win, node, name); },
                    },
                    { text: t('Close'), handler: function () { win.close(); } },
                ],
            });
        } catch (e) {
            ANAS.warn('backup detail window failed: ' + ANAS.errText(e));
            return;
        }
        // The view behind the grid that opened this window. The Restore door
        // hands it to the restore dialog as the poll view — a dialog opened
        // from THIS window must outlive the detail window being closed.
        win._view = view;
        win.show();
        loadDetailInto(win, node, name);
    }

    // ======================================================================
    //  Task wizard (create / edit) — 'anas-win-backup-task'
    // ======================================================================

    // Build one archive editor row (a bordered fieldset). Fields are addressed
    // RELATIVE to the fieldset (fs.down('#archName')) so itemIds never collide
    // across rows — win.down() is never used to reach an archive field.
    function addArchiveRow(win, cont, pathStore, data, node) {
        data = data || {};
        var fs;
        try {
            fs = cont.add({
                xtype: 'fieldset',
                cls: 'anas-backup-archive',
                border: true,
                margin: '0 0 8 0',
                padding: '6 10 8',
                layout: 'anchor',
                defaults: { anchor: '100%', labelWidth: 120 },
                items: [
                    {
                        xtype: 'fieldcontainer',
                        layout: 'hbox',
                        items: [
                            {
                                // backup2.9 — SHOWN, not editable: the archive
                                // name is pbc's change-detection key. A row
                                // with a stored name keeps it verbatim (a
                                // re-derivation would silently turn the next
                                // run into a full re-read); a row created now
                                // gets its name from the path's last segment —
                                // derived against the names the task already
                                // carries, never re-derived once stored.
                                xtype: 'textfield',
                                itemId: 'archName',
                                cls: 'anas-fld-backup-arch-name',
                                fieldLabel: t('Archive name'),
                                labelWidth: 120,
                                flex: 1,
                                readOnly: true,
                                emptyText: t('derived from the path'),
                                value: bareArchive(data.name || ''),
                            },
                            {
                                // The stored suffix, shown so the archive's real
                                // name on the server is never a guess. It follows
                                // the Kind control (backup2.4).
                                xtype: 'component',
                                itemId: 'archSuffix',
                                cls: 'anas-backup-arch-suffix',
                                margin: '0 0 0 6',
                                style: 'line-height:24px;color:var(--anas-muted,gray);font-family:monospace;',
                                html: archiveKindOf(data) === 'img' ? '.img' : '.pxar',
                            },
                            {
                                xtype: 'button',
                                cls: 'anas-btn-backup-arch-remove',
                                iconCls: 'fa fa-trash',
                                tooltip: t('Remove this archive'),
                                margin: '0 0 0 8',
                                handler: function () {
                                    try {
                                        cont.remove(fs);
                                    } catch (e) {
                                        ANAS.warn('archive remove failed: ' + ANAS.errText(e));
                                    }
                                },
                            },
                        ],
                    },
                    {
                        // backup2.4 — Files or Block image. Changing it rewrites
                        // what the rest of the row means, so every dependent
                        // control is re-synced (and re-scanned) on change.
                        xtype: 'combobox',
                        itemId: 'archKind',
                        cls: 'anas-fld-backup-arch-kind',
                        fieldLabel: t('Kind'),
                        labelWidth: 120,
                        editable: false,
                        queryMode: 'local',
                        valueField: 'kind',
                        displayField: 'label',
                        store: Ext.create('Ext.data.Store', {
                            fields: ['kind', 'label'],
                            data: [
                                { kind: 'pxar', label: t('Files — a directory tree') },
                                { kind: 'img', label: t('Block image — a device or a raw image file') },
                            ],
                        }),
                        value: archiveKindOf(data),
                        listeners: {
                            change: function () {
                                syncArchiveKind(fs);
                                scanArchiveNested(fs, node);
                            },
                        },
                    },
                    {
                        // The path field + a folder button that opens the
                        // directory picker. Free-form typing (the combobox) stays
                        // first-class; the picker just fills the field.
                        xtype: 'fieldcontainer',
                        fieldLabel: t('Path'),
                        labelWidth: 120,
                        layout: 'hbox',
                        items: [
                            {
                                xtype: 'combobox',
                                itemId: 'archPath',
                                cls: 'anas-fld-backup-arch-path',
                                flex: 1,
                                store: pathStore,
                                valueField: 'path',
                                displayField: 'label',
                                queryMode: 'local',
                                editable: true,
                                forceSelection: false,
                                anyMatch: true,
                                emptyText: '/etc',
                                value: data.path || '',
                                listeners: {
                                    // A new source has different boundaries — rescan.
                                    // DEBOUNCED: `change` fires per keystroke, and each
                                    // scan is a real tree walk on the node.
                                    // The kind sync rides along so a LUN identity
                                    // stops being shown the moment the path stops
                                    // being the one it was picked at. A NEW row's
                                    // derived name follows the path too (backup2.9);
                                    // stored rows are never touched.
                                    change: function () {
                                        syncArchiveKind(fs);
                                        syncArchiveName(fs);
                                        scheduleNestedScan(fs, node);
                                    },
                                },
                            },
                            {
                                xtype: 'button',
                                itemId: 'archBrowse',
                                cls: 'anas-btn-backup-arch-browse',
                                iconCls: 'fa fa-folder-open',
                                tooltip: t('Browse for a directory'),
                                margin: '0 0 0 6',
                                handler: function () {
                                    var f = fs.down('#archPath');
                                    var cur = f ? trim(f.getValue()) : '';
                                    openDirPicker(node, cur, function (chosen) {
                                        if (f) {
                                            f.setValue(chosen);
                                        }
                                    });
                                },
                            },
                            {
                                // backup2.4 — the block-storage sibling of the
                                // directory picker. It FILLS the path field (and
                                // records which LUN was picked); typing a device
                                // or file path by hand stays first-class.
                                xtype: 'button',
                                itemId: 'archLun',
                                cls: 'anas-btn-backup-arch-lun',
                                iconCls: 'fa fa-hdd-o',
                                text: t('LUN…'),
                                tooltip: t('Pick an iSCSI LUN served by this node'),
                                margin: '0 0 0 6',
                                hidden: archiveKindOf(data) !== 'img',
                                handler: function () {
                                    openLunPicker(node, function (chosen) {
                                        var f = fs.down('#archPath');
                                        if (f) {
                                            f.setValue(chosen.path);
                                        }
                                        // The record follows the PATH: it is only
                                        // sent while the field still holds the
                                        // path this LUN was picked at.
                                        fs.anasLun = { targetIqn: chosen.targetIqn, index: chosen.index };
                                        fs.anasLunPath = chosen.path;
                                        syncArchiveKind(fs);
                                    });
                                },
                            },
                        ],
                    },
                    {
                        xtype: 'textareafield',
                        itemId: 'archExcludes',
                        cls: 'anas-fld-backup-arch-excludes',
                        fieldLabel: t('Excludes'),
                        height: 60,
                        emptyText: t('one pattern per line — e.g. **/*.tmp'),
                        value: (isArray(data.excludes) ? data.excludes.join('\n') : (data.excludes || '')),
                    },
                    {
                        // backup2.2 — filesystem boundaries are a CHOICE, never a
                        // silent omission. None is the client's own behaviour
                        // (and PVE's lead); absent shows as None and saves as
                        // nothing at all.
                        xtype: 'combobox',
                        itemId: 'archNested',
                        cls: 'anas-fld-backup-arch-nested',
                        fieldLabel: t('Include nested filesystems'),
                        labelWidth: 170,
                        editable: false,
                        queryMode: 'local',
                        valueField: 'mode',
                        displayField: 'label',
                        store: Ext.create('Ext.data.Store', {
                            fields: ['mode', 'label'],
                            data: [
                                { mode: 'none', label: t('None (default) — nested filesystems are stored empty') },
                                { mode: 'all', label: t('All — every filesystem under this path') },
                                { mode: 'choose', label: t('Choose…') },
                            ],
                        }),
                        value: nestedModeOf(data),
                        listeners: {
                            change: function () {
                                syncArchiveNested(fs);
                                scanArchiveNested(fs, node);
                            },
                        },
                    },
                    {
                        xtype: 'textareafield',
                        itemId: 'archNestedPaths',
                        cls: 'anas-fld-backup-arch-nested-paths',
                        fieldLabel: t('Nested paths'),
                        labelWidth: 170,
                        height: 54,
                        hidden: nestedModeOf(data) !== 'choose',
                        emptyText: t('one absolute path per line — e.g. /etc/pve'),
                        value: (function () {
                            var choice = nestedChoiceOf(data);
                            return isArray(choice) ? choice.join('\n') : '';
                        }()),
                        listeners: {
                            blur: function () { scheduleNestedScan(fs, node); },
                        },
                    },
                    {
                        // backup2.4 — the two facts about a block image that
                        // cost money if they are learned later, plus the LUN
                        // identity when the source was picked as one.
                        xtype: 'component',
                        itemId: 'archImageNote',
                        cls: 'anas-backup-arch-image-note',
                        margin: '2 0 0 0',
                        hidden: archiveKindOf(data) !== 'img',
                        html: '',
                    },
                    {
                        xtype: 'component',
                        itemId: 'archNestedAlert',
                        cls: 'anas-backup-arch-nested-alert',
                        margin: '2 0 0 0',
                        html: '',
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('archive row add failed: ' + ANAS.errText(e));
        }
        if (fs) {
            // The stored LUN record travels with the row and with the PATH it
            // was recorded at — see readArchives.
            fs.anasLun = lunRefOf(data);
            fs.anasLunPath = fs.anasLun ? ('' + (data.path == null ? '' : data.path)) : '';
            // backup2.9 — a row the seed had no name for is a NEW row: its
            // name is the live derivation from the path. A seeded name is
            // STORED and never re-derived.
            fs.anasNameNew = !bareArchive(data.name || '');
            syncArchiveKind(fs);
            syncArchiveNested(fs);
            syncArchiveName(fs);
            scanArchiveNested(fs, node);
        }
        return fs;
    }

    // Kind decides what the rest of the row MEANS. For a block image the
    // excludes and nested-filesystem controls are hidden AND DISABLED — the
    // daemon refuses both on an `img` archive, so leaving a readable stale value
    // behind would turn a kind switch into a rejected save with no visible
    // cause. Read by itemId off the ROW (itemIds repeat across rows).
    function syncArchiveKind(fs) {
        try {
            if (!fs || fs.destroyed || fs.destroying) {
                return;
            }
            var kindF = fs.down('#archKind');
            var img = kindF ? ('' + (kindF.getValue() || 'pxar')) === 'img' : false;
            var suffix = fs.down('#archSuffix');
            if (suffix) {
                suffix.update(img ? '.img' : '.pxar');
            }
            var lunBtn = fs.down('#archLun');
            if (lunBtn) {
                lunBtn.setVisible(img);
            }
            var browse = fs.down('#archBrowse');
            if (browse) {
                browse.setVisible(!img);
            }
            var fields = ['#archExcludes', '#archNested', '#archNestedPaths'];
            for (var i = 0; i < fields.length; i++) {
                var f = fs.down(fields[i]);
                if (!f) {
                    continue;
                }
                f.setVisible(!img);
                f.setDisabled(img);
            }
            var note = fs.down('#archImageNote');
            if (note) {
                note.setVisible(img);
                note.update(img ? imageNoteHtml(fs) : '');
            }
            if (!img) {
                // A file archive carries no LUN record — dropping it here is the
                // same "absent is the clear" rule the save path uses.
                fs.anasLun = null;
                fs.anasLunPath = '';
                syncArchiveNested(fs);
            }
        } catch (e) {
            ANAS.warn('archive kind sync failed: ' + ANAS.errText(e));
        }
    }

    // backup2.9 — keep a NEW row's name tracking its path: the last segment,
    // sanitised, auto-suffixed against the SIBLINGS' current names (the names
    // the task already carries, in the order the rows stand). Stored rows are
    // never touched — their name is part of what change-detection keys on, and
    // a re-derivation here would be the 10 TB question made invisible.
    function syncArchiveName(fs) {
        try {
            if (!fs || !fs.anasNameNew || fs.destroyed || fs.destroying) {
                return;
            }
            var nameF = fs.down('#archName');
            var pathF = fs.down('#archPath');
            if (!nameF || !pathF) {
                return;
            }
            var path = trim(pathF.getValue());
            if (!path) {
                nameF.setValue('');
                return;
            }
            var taken = [];
            var cont = fs.up ? fs.up('#archivesContainer') : null;
            if (cont && cont.items) {
                cont.items.each(function (other) {
                    if (other === fs || !other || other.destroyed) {
                        return;
                    }
                    var n = other.down ? other.down('#archName') : null;
                    if (n) {
                        var v = bareArchive(n.getValue());
                        if (v) {
                            taken.push(v);
                        }
                    }
                });
            }
            nameF.setValue(deriveArchiveName(path, taken));
        } catch (e) {
            ANAS.warn('archive name sync failed: ' + ANAS.errText(e));
        }
    }

    /**
     * The two honest statements every block-image archive carries, and the LUN
     * identity when there is one. Both statements are ground truth, not caution:
     * `--change-detection-mode` is a complete no-op for an image (there is no
     * metadata/payload split at all), and an image of a LIVE device is
     * crash-consistent — what a power cut would have left, not a quiesced state.
     */
    function imageNoteHtml(fs) {
        // The LUN identity is shown only while the path field still holds the
        // path it was picked at — exactly the condition under which it is SENT.
        var pathF = fs && fs.down ? fs.down('#archPath') : null;
        var current = trim(pathF ? pathF.getValue() : '');
        var lun = (fs && fs.anasLun && fs.anasLunPath === current) ? fs.anasLun : null;
        var lines = '<div style="font-size:11px;color:var(--anas-muted,gray);">'
            + '<i class="fa fa-info-circle" style="margin-right:5px;"></i>'
            + enc(t('Every run reads the full image (the change-detection mode does not apply to an image).'))
            + '</div>'
            + '<div style="font-size:11px;color:var(--anas-muted,gray);">'
            + '<i class="fa fa-info-circle" style="margin-right:5px;"></i>'
            + enc(t('A backup of a live LUN is crash-consistent.'))
            + '</div>';
        if (lun) {
            lines += '<div style="font-size:11px;color:var(--anas-muted,gray);">'
                + '<i class="fa fa-hdd-o" style="margin-right:5px;"></i>'
                + '<span style="font-family:monospace;">' + enc(lunLabel(lun)) + '</span></div>';
        }
        return lines;
    }

    // Show the path list only for Choose… — the two other modes have nothing to
    // type. Read by itemId off the ROW, never win.down() (itemIds repeat).
    function syncArchiveNested(fs) {
        try {
            if (!fs || fs.destroyed || fs.destroying) {
                return;
            }
            var modeF = fs.down('#archNested');
            // Read the CONTROL, not the derived value: an empty Choose… list is
            // still Choose… (deriving it would hide the field being typed into).
            var mode = modeF ? ('' + (modeF.getValue() || 'none')) : 'none';
            var paths = fs.down('#archNestedPaths');
            if (paths) {
                paths.setVisible(mode === 'choose');
            }
        } catch (e) {
            ANAS.warn('nested control sync failed: ' + ANAS.errText(e));
        }
    }

    /** The row's current choice, in the stored shape ('none' | 'all' | [paths]). */
    function nestedFromRow(fs) {
        var modeF = fs && fs.down ? fs.down('#archNested') : null;
        var mode = modeF ? ('' + (modeF.getValue() || 'none')) : 'none';
        if (mode === 'all') {
            return 'all';
        }
        if (mode !== 'choose') {
            return 'none';
        }
        var pathsF = fs.down('#archNestedPaths');
        var paths = splitLines(pathsF ? pathsF.getValue() : '');
        return paths.length ? paths : 'none';
    }

    function nestedAlertOut(fs, html) {
        try {
            var out = fs && fs.down ? fs.down('#archNestedAlert') : null;
            if (out && !out.destroyed && !out.destroying) {
                out.update(html);
            }
        } catch (e) {
            ANAS.warn('nested alert render failed: ' + ANAS.errText(e));
        }
    }

    // One line per nested filesystem found under the source, ALWAYS naming its
    // kind — included ones in the muted/ok colour, excluded ones amber under an
    // alert that says exactly what happens to them.
    function nestedAlertHtml(scan) {
        var found = (scan && isArray(scan.nested)) ? scan.nested : [];
        var excluded = excludedNested(scan);
        var truncated = scan && scan.truncated === true;
        // backup2.3 — the consistency chip is shown even when nothing is nested:
        // "this source is backed up live" is exactly the fact Epic 16 never said
        // out loud, and the wizard is where it belongs.
        var chip = consistencyChipHtml(scan);
        var expansion = expansionLineHtml(scan);
        var consistencyRow = chip
            ? ('<div style="font-size:11px;margin-bottom:3px;">' + chip
                + (expansion
                    ? '<span style="color:var(--anas-muted,gray);margin-left:6px;">' + expansion + '</span>'
                    : '')
                + '</div>')
            : '';
        if (!found.length && !truncated) {
            return consistencyRow;
        }
        var head = consistencyRow;
        if (excluded.length) {
            head += '<div style="font-size:11px;color:var(--anas-warn,#c9820b);">'
                + '<i class="fa fa-exclamation-triangle" style="margin-right:5px;"></i>'
                + enc(excluded.length + ' '
                    + (excluded.length === 1 ? t('nested filesystem') : t('nested filesystems'))
                    + ' ' + t('will be backed up as empty directories')) + '</div>';
        } else if (found.length) {
            head += '<div style="font-size:11px;color:var(--anas-ok,#1f9c56);">'
                + '<i class="fa fa-check" style="margin-right:5px;"></i>'
                + enc(found.length + ' '
                    + (found.length === 1 ? t('nested filesystem') : t('nested filesystems'))
                    + ' ' + t('will be included')) + '</div>';
        }
        var rows = '';
        for (var i = 0; i < found.length; i++) {
            var n = found[i] || {};
            var on = n.included === true;
            var colour = on ? 'var(--anas-muted,gray)' : 'var(--anas-warn,#c9820b)';
            rows += '<div style="font-size:11px;margin-left:18px;color:' + colour + ';">'
                + '<span style="font-family:monospace;">' + enc(n.path || '') + '</span> ('
                + enc(nestedKindLabel(n.kind)) + ') — '
                + enc(on ? t('included') : t('stored as an empty directory')) + '</div>';
        }
        var note = truncated
            ? '<div style="font-size:11px;color:var(--anas-muted,gray);margin-left:18px;">'
                + enc(t('The scan did not finish — there may be more than listed.')) + '</div>'
            : '';
        return head + rows + note;
    }

    // Coalesce the scans a typed path would otherwise fire per keystroke — one
    // walk per pause, never one per character.
    var NESTED_SCAN_DEBOUNCE_MS = 400;

    function scheduleNestedScan(fs, node) {
        if (!fs || fs.destroyed || fs.destroying) {
            return;
        }
        try {
            if (fs.anasNestedTimer) {
                clearTimeout(fs.anasNestedTimer);
            }
            fs.anasNestedTimer = setTimeout(function () {
                fs.anasNestedTimer = null;
                scanArchiveNested(fs, node);
            }, NESTED_SCAN_DEBOUNCE_MS);
        } catch (e) {
            // No timers? Scan straight away rather than not at all.
            scanArchiveNested(fs, node);
        }
    }

    // Ask the daemon what is nested under this row's path. USER-INITIATED (a row
    // opened or edited), one-shot, non-mutating and entirely local — the
    // save-time verify pattern, with no PBS contact at all.
    //
    // Two in-flight scans on the SAME row can resolve out of order (a slow
    // first walk answering after a fast second one): the last to RESOLVE would
    // paint #archNestedAlert for a path the row no longer holds. Every request
    // stamps the row's monotonic sequence and drops its own resolution when the
    // row has moved on — the stale verdict never paints.
    function scanArchiveNested(fs, node) {
        if (!fs || fs.destroyed || fs.destroying) {
            return;
        }
        var seq = (fs.anasScanSeq = (fs.anasScanSeq || 0) + 1);
        var stale = function () {
            return fs.destroyed || fs.destroying || fs.anasScanSeq !== seq;
        };
        var pathF = fs.down('#archPath');
        var path = trim(pathF ? pathF.getValue() : '');
        if (!path || path.charAt(0) !== '/') {
            nestedAlertOut(fs, '');
            return;
        }
        var kindF = fs.down('#archKind');
        var img = kindF ? ('' + (kindF.getValue() || 'pxar')) === 'img' : false;
        var body = { path: path, includeNested: img ? 'none' : nestedFromRow(fs) };
        if (img) {
            // The daemon skips the tree walk for an image source and answers with
            // the derived consistency alone — nothing is stat'ed.
            body.kind = 'img';
        }
        nestedAlertOut(fs, '<div style="font-size:11px;color:var(--anas-muted,gray);">'
            + '<i class="fa fa-refresh fa-spin" style="margin-right:5px;"></i>'
            + enc(img ? t('checking this image source…') : t('checking for nested filesystems…')) + '</div>');
        ANAS.api.post(node, '/backup/tasks/preview-nested', body).then(
            function (res) {
                if (stale()) {
                    return;
                }
                var d = (res && res.data) || {};
                var scans = isArray(d.archives) ? d.archives : [];
                nestedAlertOut(fs, nestedAlertHtml(scans[0]));
            },
            function (err) {
                if (stale()) {
                    return;
                }
                // Fail-open and HONEST: an unavailable scan says so, it never
                // renders as "nothing is nested".
                nestedAlertOut(fs, '<div style="font-size:11px;color:var(--anas-muted,gray);">'
                    + enc(t('Could not check for nested filesystems') + ': ' + ANAS.errText(err)) + '</div>');
            }
        );
    }

    function readArchives(win) {
        var out = [];
        var cont = win.down('#archivesContainer');
        if (!cont || !cont.items) {
            return out;
        }
        cont.items.each(function (fs) {
            if (!fs || fs.destroyed) {
                return;
            }
            var nameF = fs.down('#archName');
            var pathF = fs.down('#archPath');
            var exclF = fs.down('#archExcludes');
            var name = bareArchive(nameF ? nameF.getValue() : '');
            var path = trim(pathF ? pathF.getValue() : '');
            if (!name && !path) {
                return; // skip a wholly-empty row
            }
            var kindF = fs.down('#archKind');
            var img = kindF ? ('' + (kindF.getValue() || 'pxar')) === 'img' : false;
            var row = {
                name: name,
                path: path,
                // A block image has no excludes — the daemon refuses them, so the
                // (disabled) field's contents are never read for one.
                excludes: img ? [] : splitLines(exclF ? exclF.getValue() : ''),
            };
            // backup2.2 — set / clear / keep: a chosen value is SENT, and None
            // is sent as NOTHING. Archives are replaced wholesale on every save,
            // so an omitted field IS the clear — and a task that never chose one
            // rewrites its unit byte-for-byte (the dialog ↔ daemon contract).
            var nested = img ? 'none' : nestedFromRow(fs);
            if (nested !== 'none') {
                row.includeNested = nested;
            }
            // backup2.4 — the same rule for kind: 'img' is sent, Files is sent as
            // NOTHING (absent already means pxar), so a pre-backup2.4 archive
            // still rewrites byte-for-byte. The LUN record rides along only while
            // the path field still holds the path it was recorded at — a
            // re-typed path is a different source, and a stale LUN reference
            // would be a lie the restore story would act on.
            if (img) {
                row.kind = 'img';
                if (fs.anasLun && fs.anasLunPath === path) {
                    row.lun = { targetIqn: fs.anasLun.targetIqn, index: fs.anasLun.index };
                }
            }
            out.push(row);
        });
        return out;
    }

    // ---- Schedule / cadence picker (16.10) ---------------------------------
    //
    // NOTHING here mirrors form state through a hiddenfield (issue #26): a
    // Text-class getValue() hands back DOM strings, where the string 'false' is
    // truthy. Every value is read straight off its own field by itemId, radios by
    // string compare and checkboxes by an explicit === true.

    function weekdayOptions() {
        var data = [];
        for (var i = 0; i < WEEKDAYS.length; i++) {
            data.push({ v: WEEKDAYS[i], label: t(WEEKDAY_LABEL[WEEKDAYS[i]]) });
        }
        return data;
    }

    var CADENCE_NOTE = {
        weekly: 'Fires on each chosen weekday. A run missed while the node was off '
            + 'is caught up once on the next boot.',
        biweekly: 'Fires on that weekday in even or odd ISO week numbers (the same '
            + 'week numbering as "date +%V"). systemd calendars cannot say "every other '
            + 'week", so the timer fires weekly and ANAS skips the off weeks — visibly, '
            + 'as a skipped run. If a full period ever passes without a successful '
            + 'backup, the next fire runs regardless and then returns to the chosen weeks.',
        monthly: 'Fires on the first such weekday of each month.',
        custom: 'systemd OnCalendar — e.g. "daily", "02:00", "Mon *-*-* 03:00". '
            + 'Validated when saved.',
    };

    // The Schedule fieldset. `cadence` is null for a raw-OnCalendar task, which
    // opens on Custom with its expression prefilled — no migration, no surprise.
    function scheduleFieldset(cadence, task, onChange) {
        var kind = cadence ? cadence.kind : 'custom';
        var days = cadence ? cadence.days : [];
        var time = (cadence && cadence.time) || DEFAULT_TIME;
        var parity = (cadence && cadence.parity) || 'even';
        var oneDay = days.length ? days[0] : 'Sun';

        var dayBoxes = [];
        for (var i = 0; i < WEEKDAYS.length; i++) {
            var d = WEEKDAYS[i];
            dayBoxes.push({
                xtype: 'checkboxfield',
                itemId: 'day' + d,
                cls: 'anas-fld-backup-day',
                boxLabel: t(d),
                checked: days.indexOf(d) >= 0,
                width: 66,
            });
        }

        return {
            xtype: 'fieldset',
            title: t('Schedule'),
            cls: 'anas-backup-schedule',
            collapsible: false,
            defaults: { anchor: '100%', labelWidth: 130 },
            items: [
                {
                    xtype: 'radiogroup',
                    itemId: 'cadenceKind',
                    cls: 'anas-fld-backup-cadence',
                    columns: 2,
                    items: [
                        { boxLabel: t('Weekly'), name: 'cadenceKind', inputValue: 'weekly', checked: kind === 'weekly' },
                        { boxLabel: t('Every other week'), name: 'cadenceKind', inputValue: 'biweekly', checked: kind === 'biweekly' },
                        { boxLabel: t('Monthly'), name: 'cadenceKind', inputValue: 'monthly', checked: kind === 'monthly' },
                        { boxLabel: t('Custom (OnCalendar)'), name: 'cadenceKind', inputValue: 'custom', checked: kind === 'custom' },
                    ],
                    listeners: {
                        change: function () {
                            try {
                                onChange();
                            } catch (e) {
                                ANAS.warn('backup cadence toggle failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                },
                {
                    xtype: 'fieldcontainer',
                    itemId: 'weeklyDaysRow',
                    fieldLabel: t('Days'),
                    layout: 'hbox',
                    defaults: { margin: '0 4 0 0' },
                    items: dayBoxes,
                },
                {
                    xtype: 'combobox',
                    itemId: 'singleDay',
                    cls: 'anas-fld-backup-single-day',
                    fieldLabel: t('Day'),
                    store: Ext.create('Ext.data.Store', { fields: ['v', 'label'], data: weekdayOptions() }),
                    valueField: 'v',
                    displayField: 'label',
                    queryMode: 'local',
                    editable: false,
                    forceSelection: true,
                    value: oneDay,
                },
                {
                    xtype: 'radiogroup',
                    itemId: 'parityGroup',
                    cls: 'anas-fld-backup-parity',
                    fieldLabel: t('Weeks'),
                    columns: 2,
                    items: [
                        { boxLabel: t('Even ISO weeks'), name: 'parity', inputValue: 'even', checked: parity !== 'odd' },
                        { boxLabel: t('Odd ISO weeks'), name: 'parity', inputValue: 'odd', checked: parity === 'odd' },
                    ],
                },
                {
                    xtype: 'textfield',
                    itemId: 'cadenceTime',
                    cls: 'anas-fld-backup-time',
                    fieldLabel: t('Time'),
                    emptyText: DEFAULT_TIME,
                    width: 260,
                    anchor: null,
                    value: time,
                    regex: TIME_RE,
                    regexText: t('A 24-hour time, HH:MM.'),
                },
                {
                    xtype: 'textfield',
                    itemId: 'schedule',
                    cls: 'anas-fld-backup-schedule',
                    fieldLabel: t('OnCalendar'),
                    emptyText: 'daily',
                    value: (task.schedule || ''),
                },
                {
                    xtype: 'component',
                    itemId: 'cadenceNote',
                    style: 'color:var(--anas-muted,gray);font-size:11px;margin:2px 0 0 134px;',
                    html: enc(t(CADENCE_NOTE[kind] || CADENCE_NOTE.custom)),
                },
            ],
        };
    }

    // The chosen cadence kind, read off the radiogroup by itemId (string compare).
    function cadenceKindOf(win) {
        try {
            var g = win.down('#cadenceKind');
            var v = g && g.getValue();
            var k = '' + ((v && v.cadenceKind) || '');
            return CADENCE_KINDS.indexOf(k) >= 0 ? k : 'custom';
        } catch (e) {
            return 'custom';
        }
    }

    // Show only the fields the chosen kind actually uses.
    function syncCadenceFields(win) {
        var kind = cadenceKindOf(win);
        var show = function (sel, on) {
            try {
                var c = win.down(sel);
                if (c) {
                    c.setHidden(!on);
                }
            } catch (e) {
                // A missing field is not worth breaking the dialog for.
            }
        };
        show('#weeklyDaysRow', kind === 'weekly');
        show('#singleDay', kind === 'biweekly' || kind === 'monthly');
        show('#parityGroup', kind === 'biweekly');
        show('#cadenceTime', kind !== 'custom');
        show('#schedule', kind === 'custom');
        try {
            var note = win.down('#cadenceNote');
            if (note) {
                note.update(enc(t(CADENCE_NOTE[kind] || CADENCE_NOTE.custom)));
            }
        } catch (e2) {
            ANAS.warn('backup cadence note failed: ' + ANAS.errText(e2));
        }
    }

    // Build the cadence object for a non-custom kind, or null after alerting.
    // Validated here AND in the daemon (defence in depth, never frontend-only).
    function readCadence(win) {
        var kind = cadenceKindOf(win);
        var time = trim(valOf(win, '#cadenceTime'));
        if (!TIME_RE.test(time)) {
            ANAS.alertMsg('Invalid input', t('Enter a time as HH:MM (24-hour).'));
            return null;
        }
        var days = [];
        if (kind === 'weekly') {
            var row = win.down('#weeklyDaysRow');
            for (var i = 0; i < WEEKDAYS.length; i++) {
                var cb = row && row.down('#day' + WEEKDAYS[i]);
                if (cb && cb.getValue() === true) {
                    days.push(WEEKDAYS[i]);
                }
            }
            if (!days.length) {
                ANAS.alertMsg('Invalid input', t('Choose at least one weekday.'));
                return null;
            }
        } else {
            var one = trim(valOf(win, '#singleDay'));
            if (WEEKDAYS.indexOf(one) < 0) {
                ANAS.alertMsg('Invalid input', t('Choose a weekday.'));
                return null;
            }
            days = [one];
        }
        var cadence = { kind: kind, days: days, time: time };
        if (kind === 'biweekly') {
            var parity = 'even';
            try {
                var pg = win.down('#parityGroup');
                var pv = pg && pg.getValue();
                if (pv && pv.parity === 'odd') {
                    parity = 'odd';
                }
            } catch (e) {
                // even stands
            }
            cadence.parity = parity;
        }
        return cadence;
    }

    // ---- Retention fieldset (16.11) ----------------------------------------

    // The five keep numberfields, seeded from the task. Blank = unset (no
    // hiddenfields anywhere — issue #26; numberfields are read directly).
    function retentionItems(task) {
        var current = retentionOf(task);
        var items = [];
        for (var i = 0; i < KEEP_FIELDS.length; i++) {
            var f = KEEP_FIELDS[i];
            items.push({
                xtype: 'numberfield',
                itemId: f.key,
                cls: 'anas-fld-backup-' + f.key.toLowerCase(),
                fieldLabel: t(f.label),
                emptyText: t('(none)'),
                value: current[f.key] === undefined ? null : current[f.key],
                minValue: 1,
                allowDecimals: false,
                allowBlank: true,
                hideTrigger: false,
                width: 260,
            });
        }
        return items;
    }

    // Read the keep fields back: positive whole numbers only; everything else
    // (blank, 0, junk) is simply absent — the daemon then stores no policy.
    function readRetention(win) {
        var out = {};
        for (var i = 0; i < KEEP_FIELDS.length; i++) {
            var key = KEEP_FIELDS[i].key;
            var n = Number(valOf(win, '#' + key));
            if (!isNaN(n) && n > 0 && n === Math.floor(n)) {
                out[key] = n;
            }
        }
        return out;
    }

    // Preview needs a repository, a backup-id and at least one keep — with no
    // keep flags PBS keeps everything, so there is nothing to preview.
    function syncRetentionControls(win) {
        var btn = win.down('#retentionPreview');
        if (!btn) {
            return;
        }
        var ready = !!valOf(win, '#repository') && !!trim(valOf(win, '#backupId'))
            && hasKeeps(readRetention(win));
        try {
            btn.setDisabled(!ready);
        } catch (e) {
            // non-fatal
        }
    }

    function previewOut(win, html) {
        var out = win.down('#retentionPreviewOut');
        if (out && !out.destroyed && !out.destroying) {
            try {
                out.update(html);
            } catch (e) {
                ANAS.warn('retention preview render failed: ' + ANAS.errText(e));
            }
        }
    }

    // A prune snapshot's timestamp (PBS backup-time — unix SECONDS).
    function snapTime(sec) {
        var n = Number(sec);
        if (isNaN(n)) {
            return '';
        }
        try {
            return absTime(new Date(n * 1000).toISOString());
        } catch (e) {
            return '';
        }
    }

    function prunePreviewHtml(result) {
        var snaps = (result && result.snapshots) || [];
        if (!isArray(snaps) || !snaps.length) {
            return '<div style="color:var(--anas-muted,gray);font-size:11px;">'
                + enc(t('No snapshots in this group yet — nothing to prune.')) + '</div>';
        }
        var kept = Number(result.kept) || 0;
        var removed = Number(result.removed) || 0;
        var head = '<div style="font-size:11px;margin-bottom:4px;">'
            + enc(kept + ' ' + t('would be kept') + ', ' + removed + ' ' + t('would be removed'))
            + (result.protectedCount
                ? enc(', ' + result.protectedCount + ' ' + t('protected (always kept)')) : '')
            + '</div>';
        var rows = '';
        for (var i = 0; i < snaps.length; i++) {
            var s = snaps[i] || {};
            var keep = s.keep === true;
            var color = keep ? 'var(--anas-ok,#1f9c56)' : 'var(--anas-danger,#c23b2c)';
            rows += '<tr><td style="padding:1px 10px 1px 0;color:' + color + ';white-space:nowrap;">'
                + enc(keep ? t('keep') : t('remove')) + '</td>'
                + '<td style="padding:1px 0;font-family:monospace;font-size:11px;white-space:nowrap;">'
                + enc(snapTime(s.backupTime)) + '</td>'
                + '<td style="padding:1px 0 1px 10px;color:var(--anas-muted,gray);font-size:11px;">'
                + enc(s.protected === true ? t('protected') : '') + '</td></tr>';
        }
        return head + '<div style="max-height:150px;overflow:auto;">'
            + '<table style="border-collapse:collapse;">' + rows + '</table></div>';
    }

    // The dry-run preview: USER-INITIATED and one-shot (the save-time namespace
    // check is the precedent) — never polled, never automatic. The whole task
    // shape is sent inline so an unsaved task previews too.
    function previewRetention(win, node) {
        var name = trim(valOf(win, '#name'));
        var retention = readRetention(win);
        if (!hasKeeps(retention)) {
            return;
        }
        var body = {
            repository: valOf(win, '#repository'),
            backupId: trim(valOf(win, '#backupId')),
            retention: retention,
        };
        var ns = trim(valOf(win, '#namespace'));
        if (ns) {
            body.namespace = ns;
        }
        previewOut(win, '<div style="color:var(--anas-muted,gray);font-size:11px;">'
            + '<i class="fa fa-refresh fa-spin" style="margin-right:6px;"></i>'
            + enc(t('asking the server…')) + '</div>');
        // The URL name is only a label for an unsaved task — the body carries
        // the values. A not-yet-valid name falls back to a placeholder.
        var urlName = NAME_RE.test(name) ? name : 'preview';
        ANAS.api.post(node, '/backup/tasks/' + encodeURIComponent(urlName) + '/prune-preview', body).then(
            function (res) {
                if (win.destroyed || win.destroying) {
                    return;
                }
                var d = (res && res.data) || {};
                if (d.verdict === 'ok' && d.result) {
                    previewOut(win, prunePreviewHtml(d.result));
                    return;
                }
                previewOut(win, '<div style="color:var(--anas-danger,#c23b2c);font-size:11px;">'
                    + enc(t('Could not preview') + ': ' + (d.detail || d.verdict || t('unknown error'))) + '</div>');
            },
            function (err) {
                if (win.destroyed || win.destroying) {
                    return;
                }
                previewOut(win, '<div style="color:var(--anas-danger,#c23b2c);font-size:11px;">'
                    + enc(t('Could not preview') + ': ' + ANAS.errText(err)) + '</div>');
            }
        );
    }

    /**
     * `existing` = the task being edited (null on create). `seedArchives` =
     * the archive rows a NEW task opens with when a second door pre-fills
     * them — the iSCSI LUN toolbar hands the LUN's block-image archive — in
     * place of the suggested etc default. The seed passes through the SAME
     * `archivesOf` an edit round-trip does, so a pre-filled row is the same
     * row a manual pick in the wizard builds.
     */
    function openTaskDialog(view, node, existing, seedArchives, preset, onDone) {
        var isEdit = !!existing;
        var task = existing || {};
        var seed = (!isEdit && isArray(seedArchives) && seedArchives.length)
            ? archivesOf({ archives: seedArchives })
            : null;
        loadRepoOptions(node).then(function (repoOpts) {
            if (!isEdit && !repoOpts.length) {
                ANAS.toast(t('Register a PBS repository first (Repositories…).'));
                return;
            }
            buildTaskWindow(view, node, isEdit, task, repoOpts, seed, preset, onDone);
        });
    }

    function buildTaskWindow(view, node, isEdit, task, repoOpts, seedArchives, preset, onDone) {
        var repoStore = Ext.create('Ext.data.Store', {
            fields: ['name', 'label'], data: repoOpts,
        });
        var pathStore = Ext.create('Ext.data.Store', { fields: ['path', 'label'], data: [] });
        var defaultRepo = repoNameOf(task);
        if (!defaultRepo && repoOpts.length) {
            defaultRepo = repoOpts[0].name;
        }
        var defaultId = backupIdOf(task) || node; // hostname is the default backup-id
        var mode = modeOf(task);
        // No cadence = a raw-OnCalendar task (everything created before 16.10):
        // it opens on Custom with its expression prefilled and round-trips as-is.
        var cadence = cadenceOf(task);

        // backup2.9 — the task's kind, chosen FIRST. Edit: the task is what it
        // IS (the effective kind — a pre-backup2.9 single-image task is a block
        // task). New: the operator's choice, or the door's pre-fill, which
        // SKIPS the choice entirely (the LUN toolbar already said block).
        var effKind = taskKindOf(task).kind;
        var presetBlock = !isEdit && preset && preset.kind === 'block';
        var initialKind = isEdit ? effKind : (presetBlock ? 'block' : 'files');
        var kindChoosable = !isEdit && !presetBlock;
        // The block task's STORED archive (edit only): the name is never
        // re-derived and the path/record ride back verbatim until a different
        // LUN is picked.
        var blockStored = null;
        if (isEdit && effKind === 'block') {
            var blockArchs = archivesOf(task);
            if (blockArchs.length) {
                var b0 = blockArchs[0];
                blockStored = {
                    name: bareArchive(b0.name || ''),
                    path: b0.path,
                    lun: lunRefOf(b0),
                };
            }
        }

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-backup-task',
                title: isEdit ? (t('Edit Backup Task') + ': ' + (task.name || '')) : t('New Backup Task'),
                modal: true,
                width: 620,
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
                            xtype: 'textfield',
                            itemId: 'name',
                            cls: 'anas-fld-backup-name',
                            fieldLabel: t('Task name'),
                            emptyText: 'nightly-pictures',
                            disabled: isEdit,
                            allowBlank: false,
                            value: task.name || '',
                            regex: NAME_RE,
                            maxLength: 64,
                            regexText: t('Lowercase letters, digits and hyphens; must start with a letter or digit.'),
                        },
                        {
                            // backup2.9 — chosen FIRST: a task is files or block,
                            // and the two panels below are different shapes, not
                            // variations. Hidden on edit (the task is what it is)
                            // and on a door-pre-filled block wizard (the LUN
                            // toolbar already said block — the choice is skipped).
                            xtype: 'radiogroup',
                            itemId: 'kindGroup',
                            cls: 'anas-fld-backup-kind',
                            fieldLabel: t('Kind'),
                            columns: 2,
                            hidden: !kindChoosable,
                            items: [
                                {
                                    boxLabel: t('Files — directory trees'),
                                    name: 'taskKind', inputValue: 'files',
                                    checked: initialKind === 'files',
                                },
                                {
                                    boxLabel: t('Block — one iSCSI LUN'),
                                    name: 'taskKind', inputValue: 'block',
                                    checked: initialKind === 'block',
                                },
                            ],
                            listeners: {
                                change: function () {
                                    var g = win.down('#kindGroup');
                                    var v = g && g.getValue ? g.getValue() : null;
                                    win.anasTaskKind = (v && v.taskKind) || 'files';
                                    syncTaskKind(win);
                                },
                            },
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'repository',
                            cls: 'anas-fld-backup-repo',
                            fieldLabel: t('Repository'),
                            store: repoStore,
                            valueField: 'name',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            allowBlank: false,
                            emptyText: t('(no repositories registered)'),
                            value: defaultRepo,
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'namespace',
                            cls: 'anas-fld-backup-namespace',
                            fieldLabel: t('Namespace (optional)'),
                            emptyText: t('(datastore root)'),
                            value: first(task.namespace) || '',
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'backupId',
                            cls: 'anas-fld-backup-id',
                            fieldLabel: t('Backup ID'),
                            allowBlank: false,
                            value: defaultId,
                        },
                        {
                            xtype: 'component',
                            style: 'color:var(--anas-muted,gray);font-size:11px;margin:-4px 0 8px 152px;',
                            html: enc(t('the PBS group identity — host/<id>. Defaults to this node\'s '
                                + 'hostname; give it a logical name (pictures, storage…) to disambiguate.')),
                        },
                        {
                            // backup2.9 — the FILES panel: today's archive list.
                            // (The class keeps its backup2.4 name; `filesPanel`
                            // is the shape switch the kind choice drives.)
                            xtype: 'fieldset',
                            title: t('Archives'),
                            itemId: 'filesPanel',
                            cls: 'anas-backup-files anas-backup-archives',
                            collapsible: false,
                            hidden: initialKind !== 'files',
                            items: [
                                {
                                    xtype: 'container',
                                    itemId: 'archivesContainer',
                                    layout: 'anchor',
                                    defaults: { anchor: '100%' },
                                },
                                {
                                    xtype: 'button',
                                    cls: 'anas-btn-backup-arch-add',
                                    text: t('Add archive'),
                                    iconCls: 'fa fa-plus',
                                    margin: '4 0 0 0',
                                    handler: function () {
                                        var cont = win.down('#archivesContainer');
                                        if (cont) {
                                            addArchiveRow(win, cont, pathStore, null, node);
                                        }
                                    },
                                },
                                {
                                    // The legacy shape, named: a derived files
                                    // task that still carries image archive(s).
                                    // The data is untouched — the note points at
                                    // the shape it should become.
                                    xtype: 'component',
                                    itemId: 'filesLegacyNote',
                                    cls: 'anas-backup-legacy-note',
                                    margin: '4 0 0 0',
                                    html: '',
                                },
                            ],
                        },
                        {
                            // backup2.9 — the BLOCK panel: the LUN picker and
                            // nothing else. No path field (the pick IS the path
                            // + the lun record), no excludes, no nested option,
                            // no change detection (a no-op for images — the
                            // fieldset below does not exist for this shape).
                            xtype: 'fieldset',
                            title: t('LUN'),
                            itemId: 'blockPanel',
                            cls: 'anas-backup-block',
                            collapsible: false,
                            hidden: initialKind !== 'block',
                            items: [
                                {
                                    xtype: 'component',
                                    itemId: 'blockLunOut',
                                    cls: 'anas-backup-block-lun',
                                    html: '',
                                },
                                {
                                    xtype: 'button',
                                    itemId: 'blockLunChoose',
                                    cls: 'anas-btn-backup-block-lun',
                                    text: t('Choose LUN…'),
                                    iconCls: 'fa fa-hdd-o',
                                    margin: '4 0 0 0',
                                    handler: function () {
                                        openLunPicker(node, function (chosen) {
                                            setBlockLun(win, chosen, true);
                                        });
                                    },
                                },
                                {
                                    // The block task's archive name: the whole
                                    // image IS the archive. New tasks get the
                                    // fixed name; an edit keeps whatever its
                                    // unit stores (never re-derived).
                                    xtype: 'textfield',
                                    itemId: 'blockArchiveName',
                                    cls: 'anas-fld-backup-block-name',
                                    fieldLabel: t('Archive name'),
                                    readOnly: true,
                                    value: (isEdit && blockStored && blockStored.name)
                                        ? blockStored.name
                                        : BLOCK_ARCHIVE_NAME,
                                },
                                {
                                    xtype: 'component',
                                    style: 'color:var(--anas-muted,gray);font-size:11px;margin-top:2px;',
                                    html: enc(t('One LUN per block task. The backup-id derives from the '
                                        + 'LUN\'s unit serial — the PBS group is the LUN itself, and it '
                                        + 'survives a rename or a re-point of the backing.')),
                                },
                            ],
                        },
                        {
                            xtype: 'fieldset',
                            title: t('Change detection'),
                            itemId: 'modePanel',
                            cls: 'anas-backup-mode',
                            collapsible: false,
                            hidden: initialKind !== 'files',
                            defaults: { anchor: '100%' },
                            items: [
                                {
                                    xtype: 'radiogroup',
                                    itemId: 'modeGroup',
                                    cls: 'anas-fld-backup-mode',
                                    columns: 1,
                                    items: [
                                        {
                                            boxLabel: t('Default — proven for large backups (data/block)'),
                                            name: 'mode', inputValue: 'default',
                                            checked: mode !== 'metadata',
                                        },
                                        {
                                            boxLabel: t('Metadata — faster re-scans for many-small-file trees'),
                                            name: 'mode', inputValue: 'metadata',
                                            checked: mode === 'metadata',
                                        },
                                    ],
                                },
                                {
                                    xtype: 'component',
                                    style: 'color:var(--anas-muted,gray);font-size:11px;margin-top:2px;',
                                    html: enc(t('Neither is universally best. Default mode holds up well, '
                                        + 'especially for big backups; metadata mode re-scans large '
                                        + 'small-file trees faster.')),
                                },
                            ],
                        },
                        // The window is synced once on show as well; this guard just
                        // ignores a change fired while the config is still building.
                        scheduleFieldset(cadence, task, function () {
                            if (win) {
                                syncCadenceFields(win);
                            }
                        }),
                        {
                            xtype: 'fieldset',
                            title: t('Retention (optional)'),
                            cls: 'anas-backup-retention',
                            collapsible: false,
                            defaults: { anchor: '100%' },
                            items: retentionItems(task).concat([
                                {
                                    xtype: 'component',
                                    style: 'color:var(--anas-muted,gray);font-size:11px;margin-top:2px;',
                                    html: enc(t('Leave every field blank and ANAS never prunes — retention stays '
                                        + 'entirely PBS-side. Set any value and ANAS runs a PBS prune with exactly '
                                        + 'these keeps after each SUCCESSFUL backup. Pruning only marks snapshots '
                                        + 'removed; space is reclaimed by the datastore\'s own garbage collection, '
                                        + 'which stays PBS-side.')),
                                },
                                {
                                    xtype: 'container',
                                    layout: 'hbox',
                                    margin: '6 0 0 0',
                                    items: [
                                        {
                                            xtype: 'button',
                                            itemId: 'retentionPreview',
                                            cls: 'anas-btn-backup-retention-preview',
                                            text: t('Preview'),
                                            iconCls: 'fa fa-eye',
                                            disabled: true,
                                            handler: function () {
                                                previewRetention(win, node);
                                            },
                                        },
                                        {
                                            xtype: 'component',
                                            flex: 1,
                                            margin: '4 0 0 8',
                                            style: 'color:var(--anas-muted,gray);font-size:11px;',
                                            html: enc(t('a dry run against the server — nothing is removed')),
                                        },
                                    ],
                                },
                                {
                                    xtype: 'component',
                                    itemId: 'retentionPreviewOut',
                                    cls: 'anas-backup-retention-preview',
                                    margin: '6 0 0 0',
                                    html: '',
                                },
                            ]),
                        },
                        // 9.4 gave snapshots + replication the same knob, so the
                        // combo itself moved to ANAS.notifyMode (00-core) and all
                        // three dialogs render one field. Only the DEFAULT and the
                        // hint below stay backup's own.
                        ANAS.notifyMode.field({
                            itemId: 'notifyMode',
                            cls: 'anas-fld-backup-notify',
                            value: notifyOf(task),
                        }),
                        {
                            xtype: 'component',
                            style: 'color:var(--anas-muted,gray);font-size:11px;margin:-4px 0 8px 152px;',
                            html: enc(t('A finished run notifies through the Proxmox notification system '
                                + '(type anas-backup) — the same matchers and targets the rest of PVE uses. '
                                + '"Always" mails every run that happened, with its archive lines, duration, '
                                + 'prune counts and warnings; "On failure" mails only a failed run or one that '
                                + 'completed with warnings. A skipped off week never notifies.')),
                        },
                        {
                            xtype: 'checkboxfield',
                            itemId: 'enabled',
                            cls: 'anas-fld-backup-enabled',
                            fieldLabel: t('Enabled'),
                            boxLabel: t('Run on the schedule'),
                            checked: task.enabled !== false,
                        },
                    ],
                }],
                buttons: [
                    { text: t('Cancel'), handler: function () { win.close(); } },
                    {
                        text: isEdit ? t('Save') : t('Create'),
                        itemId: 'taskSubmitBtn',
                        cls: 'anas-btn-backup-task-submit',
                        handler: function () {
                            try {
                                submitTask(win, view, node, isEdit, task, onDone);
                            } catch (e) {
                                ANAS.warn('backup task submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('backup task window failed: ' + ANAS.errText(e));
            return;
        }

        win.show();
        syncCadenceFields(win); // show only the fields the opening cadence uses
        loadPathCandidates(node, pathStore);

        // Preview stays disabled until a repository, a backup-id AND at least one
        // keep are present — the three things the dry run needs.
        var watched = ['#repository', '#backupId'];
        for (var w = 0; w < KEEP_FIELDS.length; w++) {
            watched.push('#' + KEEP_FIELDS[w].key);
        }
        for (var wi = 0; wi < watched.length; wi++) {
            try {
                var fld = win.down(watched[wi]);
                if (fld && fld.on) {
                    fld.on('change', function () { syncRetentionControls(win); });
                }
            } catch (eWatch) {
                // non-fatal: the button simply stays as it is
            }
        }
        syncRetentionControls(win);

        // backup2.9 — the kind state the panels and the save read. `win` must
        // exist before any of the syncs below (they look fields up off it).
        win.anasNode = node;
        win.anasTaskKind = initialKind;
        win.anasKindChoosable = kindChoosable;
        win.anasBlockNewId = !isEdit; // new: the id derives from the pick
        win.anasBlockStored = blockStored;

        // Seed the ARCHIVE rows — files panel only; a block wizard has no rows
        // (its one archive is the LUN pick). Edit → the task's archives; new →
        // a second door's pre-filled archive, else the suggested
        // etc.pxar:/etc default (the operator's own habit; removable =
        // dismissible).
        var cont = win.down('#archivesContainer');
        if (cont && initialKind === 'files') {
            var seed = archivesOf(task);
            if (!seed.length && !isEdit) {
                seed = (seedArchives && seedArchives.length)
                    ? seedArchives
                    : [{ name: 'etc', path: '/etc', excludes: [] }];
            }
            if (!seed.length) {
                seed = [{ name: '', path: '', excludes: [] }];
            }
            for (var i = 0; i < seed.length; i++) {
                addArchiveRow(win, cont, pathStore, seed[i], node);
            }
        }

        // The legacy note: a derived files task that still carries image
        // archive(s) says what to do about it — one block task per LUN.
        var legacyEff = taskKindOf(task);
        var legacyNote = win.down('#filesLegacyNote');
        if (legacyNote && isEdit && legacyEff.legacyImgArchives) {
            var imgCount = 0;
            var legacyArchs = archivesOf(task);
            for (var li = 0; li < legacyArchs.length; li++) {
                if (archiveKindOf(legacyArchs[li]) === 'img') {
                    imgCount++;
                }
            }
            legacyNote.update('<div style="font-size:11px;color:var(--anas-warn,#c9820b);">'
                + '<i class="fa fa-exclamation-triangle" style="margin-right:5px;"></i>'
                + enc(imgCount + ' ' + t('image archive') + (imgCount === 1 ? '' : t('s'))
                    + t(' in this task were written before block tasks existed. A LUN belongs in its own '
                        + 'block task (one LUN per task) — create one, and remove the image row from here '
                        + 'when its snapshots are safe.'))
                + '</div>');
        }

        // The block panel's LUN: an edit re-resolves its stored record (or
        // path) against the node's LUN list — the live name, the serial and
        // the consistency chip come from where they live; a door's pre-fill
        // re-resolves the same way (the pick is fresh, the chip is not).
        if (initialKind === 'block') {
            if (isEdit && blockStored) {
                setBlockLun(win, {
                    targetIqn: blockStored.lun ? blockStored.lun.targetIqn : '',
                    index: blockStored.lun ? blockStored.lun.index : 0,
                    path: blockStored.path,
                }, false);
            } else if (presetBlock && preset.lun) {
                setBlockLun(win, preset.lun, false);
            }
            renderBlockLun(win);
        }
        syncTaskKind(win);
    }

    // `task` is the task being edited (empty on create): the source for every
    // field the dialog does NOT show but a PUT would otherwise drop.
    function submitTask(win, view, node, isEdit, task, onDone) {
        var form = win.down('#form');
        var basicForm = form && form.getForm();
        if (basicForm && basicForm.isValid && !basicForm.isValid()) {
            ANAS.alertMsg('Invalid input', t('Fill in the required fields.'));
            return;
        }
        var name = trim(valOf(win, '#name'));
        if (!NAME_RE.test(name) || name.length > 64) {
            ANAS.alertMsg('Invalid input',
                t('Task name must be lowercase letters, digits and hyphens (≤64 chars).'));
            return;
        }
        var repository = valOf(win, '#repository');
        if (!repository) {
            ANAS.alertMsg('Invalid input', t('Choose a repository.'));
            return;
        }
        var backupId = trim(valOf(win, '#backupId'));
        if (!backupId) {
            ANAS.alertMsg('Invalid input', t('Enter a backup ID (the PBS group identity).'));
            return;
        }
        // Custom = the raw OnCalendar the user typed; every other kind sends the
        // structured cadence and lets the DAEMON generate the expression (one
        // generator, in the shared schema — never a second copy here).
        var cadenceKind = cadenceKindOf(win);
        var schedule = '';
        var cadence = null;
        if (cadenceKind === 'custom') {
            schedule = trim(valOf(win, '#schedule'));
            if (!schedule) {
                ANAS.alertMsg('Invalid input', t('Enter a schedule.'));
                return;
            }
        } else {
            cadence = readCadence(win);
            if (!cadence) {
                return; // readCadence already said what is wrong
            }
        }
        // backup2.9 — the shape decides what the body carries. A block task is
        // one LUN pick (one image archive, the fixed name on a new task, the
        // serial-derived id on a new task) and no mode; a files task is today's
        // archive list and nothing that does not exist for one.
        var taskKind = win.anasTaskKind === 'block' ? 'block' : 'files';
        var archives;
        if (taskKind === 'block') {
            var blockArch = readBlockArchive(win);
            archives = blockArch ? [blockArch] : [];
            if (!archives.length) {
                ANAS.alertMsg('Invalid input', t('Choose a LUN for the block task.'));
                return;
            }
        } else {
            archives = readArchives(win);
            if (!archives.length) {
                ANAS.alertMsg('Invalid input', t('Add at least one archive (a path).'));
                return;
            }
            for (var i = 0; i < archives.length; i++) {
                if (!archives[i].name || !archives[i].path) {
                    ANAS.alertMsg('Invalid input', t('Every archive needs both a name and a path.'));
                    return;
                }
            }
        }
        var mode;
        if (taskKind === 'block') {
            // No change detection on a block image (a complete no-op): a NEW
            // task stores the default, an EDIT keeps whatever its unit stores
            // — the daemon's block guard applies only to a stored-block task.
            mode = isEdit ? modeOf(task) : 'default';
        } else {
            mode = 'default';
            try {
                var mg = win.down('#modeGroup');
                var mv = mg && mg.getValue();
                if (mv && mv.mode) {
                    mode = mv.mode;
                }
            } catch (eMode) {
                // default stands
            }
        }
        var namespace = trim(valOf(win, '#namespace'));

        var body = {
            name: name,
            repository: repository,
            backupId: backupId,
            archives: archives,
            mode: mode,
            changeDetectionMode: mode, // send both spellings — daemon picks one
            // Read straight off the combo by itemId — no hiddenfield mirroring
            // (issue #26). An unreadable field falls back to the default mode.
            notify: valOf(win, '#notifyMode') === 'on-failure' ? 'on-failure' : 'always',
            enabled: !!valOf(win, '#enabled'),
        };
        if (cadence) {
            body.cadence = cadence;
        } else {
            body.schedule = schedule;
        }
        // backup2.9 — the stored kind rides back VERBATIM. A wizard files task
        // stores nothing (absent IS the files default) and a pre-backup2.9 LUN
        // task stores nothing either — and NOT sending `kind` is exactly what
        // keeps that task's hand-chosen id and PBS group: the daemon's serial
        // guard fires only on a task that claims to be block. A new block
        // task (or a stored-block edit) is the only send that carries it.
        if (isEdit && (task.kind === 'block' || task.kind === 'files')) {
            body.kind = task.kind;
        } else if (!isEdit && taskKind === 'block') {
            body.kind = 'block';
        }
        if (namespace) {
            body.namespace = namespace;
        }
        // Retention rides the task config (16.11). All-blank = omitted entirely:
        // no policy stored, and ANAS never prunes.
        var retention = readRetention(win);
        if (hasKeeps(retention)) {
            body.retention = retention;
        }
        // No dialog control for LimitNOFILE — carry the task's own value through
        // the save so an edit never resets a hand-raised limit to the default.
        var limitNofile = limitNofileOf(task);
        if (limitNofile !== undefined) {
            body.limitNofile = limitNofile;
        }

        var proceed = function () {
            ANAS.runJob({
                node: node,
                method: isEdit ? 'put' : 'post',
                path: isEdit ? ('/backup/tasks/' + encodeURIComponent(name)) : '/backup/tasks',
                body: body,
                view: win,
                failTitle: isEdit ? 'Save failed' : 'Create failed',
                successMsg: isEdit ? (t('Backup task saved') + ': ' + name)
                    : (t('Backup task created') + ': ' + name),
                onComplete: function () {
                    if (!win.destroyed && !win.destroying) {
                        win.close();
                    }
                    loadTasks(view, node);
                    // The door's completion callback (the iSCSI LUNs window
                    // re-reads its backup coverage). Called once, only after
                    // a successful save; the door's own screens must never be
                    // taken down by it.
                    if (onDone) {
                        try {
                            onDone();
                        } catch (eDone) {
                            ANAS.warn('backup task onDone failed: ' + ANAS.errText(eDone));
                        }
                    }
                },
            });
        };

        // Save-time verification (operator-sanctioned, warn-not-block): the
        // effective namespace (the task's, else the chosen repo's own) plus the
        // archive paths are checked before saving, and any problems are surfaced
        // in ONE combined "create anyway?" confirm — never a stack of dialogs.
        // Both checks fail-open: a broken check never blocks a save.
        var repoInfo = REPO_MAP[repository] || {};
        var effectiveNs = namespace || (repoInfo.namespace || '');
        verifyThenSave(win, node, repository, effectiveNs, archives, proceed);
    }

    // Verify the effective namespace via the (user-initiated, one-shot) repo Test
    // endpoint. Returns a Promise<string|null> — a warning fragment or null. Never
    // rejects (fail-open). A blank namespace skips (resolves null). Reuses the
    // repo Test with a namespace override so the TASK's effective namespace is
    // what gets probed (not just the repo's) — a namespace that does not exist
    // would fail the task at EVERY run (pbc ENOENT, ground truth).
    function namespaceWarning(node, repository, ns) {
        if (!ns) {
            return Promise.resolve(null);
        }
        return ANAS.api.post(node, '/backup/repos/test', { name: repository, namespace: ns }).then(
            function (res) {
                var d = (res && res.data) || {};
                var stage = '' + (first(d.stage, d.verdict) || 'ok');
                if (stage === 'ok') {
                    return null;
                }
                if (stage === 'namespace') {
                    return t('The namespace') + ' "' + enc(ns) + '" '
                        + t('does not exist on the server — this task will fail at every run until you '
                            + 'create it in the PBS UI.');
                }
                // Any OTHER stage (unreachable / auth / datastore / tls …): could
                // not verify — warn generically, still let the operator proceed.
                var detail = d.detail ? (' — ' + enc(d.detail)) : (' (' + enc(stage) + ')');
                return t('Could not verify the namespace') + detail + '.';
            },
            function (err) {
                return t('Could not verify the namespace') + ' — ' + enc(ANAS.errText(err)) + '.';
            }
        );
    }

    // Browse each distinct archive path and collect the ones that do not exist on
    // this node. Returns a Promise<string[]> (sorted); never rejects. Each browse
    // is independently fail-open — a browse error skips that path silently (a
    // broken validation must never block a save).
    function missingPathWarnings(node, archives) {
        var checks = [];
        var missing = [];
        var seen = {};
        for (var i = 0; i < archives.length; i++) {
            var p = trim(archives[i] && archives[i].path);
            if (!p || seen[p]) {
                continue;
            }
            seen[p] = true;
            (function (path) {
                checks.push(ANAS.api.get(node, '/fs/browse?path=' + encodeURIComponent(path)).then(
                    function (res) {
                        var d = (res && res.data) || {};
                        if (d.exists === false) {
                            missing.push(path);
                        }
                    },
                    function () { /* fail-open: skip this path */ }
                ));
            }(p));
        }
        return Promise.all(checks).then(function () {
            missing.sort();
            return missing;
        }, function () {
            return missing;
        });
    }

    // Run both checks in parallel, then either save or raise ONE combined confirm
    // covering whichever problems apply. The whole chain is fail-open: if it
    // breaks, the save proceeds (validation must never be what blocks a save).
    function verifyThenSave(win, node, repository, effectiveNs, archives, proceed) {
        var btn = win.down('#taskSubmitBtn');
        if (btn) { try { btn.setDisabled(true); } catch (eBtn) { /* non-fatal */ } }
        var reenable = function () {
            if (btn && !win.destroyed && !win.destroying) {
                try { btn.setDisabled(false); } catch (e) { /* non-fatal */ }
            }
        };

        Promise.all([
            namespaceWarning(node, repository, effectiveNs),
            missingPathWarnings(node, archives),
        ]).then(function (results) {
            if (win.destroyed || win.destroying) {
                return;
            }
            var nsWarn = results[0];
            var missing = results[1] || [];
            if (!nsWarn && !missing.length) {
                reenable();
                proceed();
                return;
            }
            var parts = [];
            if (nsWarn) {
                parts.push(nsWarn);
            }
            if (missing.length) {
                var list = '';
                for (var i = 0; i < missing.length; i++) {
                    list += '<div style="font-family:monospace;">' + enc(missing[i]) + '</div>';
                }
                parts.push(t('These paths do not exist on this node:')
                    + '<div style="margin-top:4px;">' + list + '</div>');
            }
            var msg = parts.join('<br><br>') + '<br><br>' + t('Create the task anyway?');
            reenable();
            try {
                Ext.Msg.confirm(t('Verify before saving'), msg, function (b) {
                    if (b === 'yes') { proceed(); }
                });
            } catch (eMsg) {
                // If the confirm dialog itself fails, do not block the save.
                ANAS.warn('backup save-verify confirm failed: ' + ANAS.errText(eMsg));
                proceed();
            }
        }, function () {
            // The whole verification chain broke — fail-open, save anyway.
            if (win.destroyed || win.destroying) {
                return;
            }
            reenable();
            proceed();
        });
    }

    // ---- Run Now (job with progress) ---------------------------------------

    function runTask(view, node, rec) {
        if (!rec) {
            return;
        }
        runTaskByName(view, node, rec.get('name'));
    }

    // The ONE run path: POST the task's /run, let the task's own systemd unit
    // do the work, and supervise through the job (one code path, one history).
    // The Backup menu hands a grid record; the iSCSI LUN toolbar (75-iscsi.js)
    // reaches in through ANAS.backup.runTaskNow with just a name — both land
    // here, so a run started from the LUNs window lands in the task's history
    // like any other.
    function runTaskByName(view, node, name) {
        if (!name) {
            return;
        }
        var grid = gridOf(view);
        ANAS.runJob({
            node: node,
            method: 'post',
            path: '/backup/tasks/' + encodeURIComponent(name) + '/run',
            body: {},
            view: grid,
            maxMs: 600000, // a real backup can run for minutes — keep polling
            failTitle: 'Run failed',
            onComplete: function (job) {
                // Retention (16.11): the prune counts ride the job result, and a
                // prune that failed AFTER a good backup comes back as a warning
                // on a COMPLETED job — surface it, never as a failure.
                var msg = t('Backup finished') + ': ' + name;
                var warnings = [];
                var notices = [];
                try {
                    var result = (job && job.result) || {};
                    if (result.prune) {
                        msg += ' — ' + t('pruned') + ': '
                            + (Number(result.prune.kept) || 0) + ' ' + t('kept') + ', '
                            + (Number(result.prune.removed) || 0) + ' ' + t('removed');
                    }
                    if (isArray(result.warnings)) {
                        warnings = result.warnings;
                    }
                    // backup2 fix-ups — nested filesystems the task's choice does
                    // not cover are NOTES, not warnings: they never change the
                    // run's status (the 2026-08-28 ruling: it is information).
                    if (isArray(result.notices)) {
                        notices = result.notices;
                    }
                } catch (e) {
                    // best-effort summary
                }
                // Notes WITHOUT warnings: no modal at all — a second popup for
                // information is wrong. The toast says where they can be read.
                if (notices.length && !warnings.length) {
                    msg += ' — ' + notices.length + ' '
                        + (notices.length === 1 ? t('note') : t('notes'))
                        + ', ' + t('see the task\'s Details');
                }
                ANAS.toast(msg);
                if (warnings.length) {
                    try {
                        var alertBody = ANAS.warningsHtml(warnings);
                        // The notes ride the ONE warning alert as a muted
                        // section — still shown, never a second modal.
                        if (notices.length) {
                            alertBody += '<div style="color:var(--anas-muted,gray);margin-top:8px;">'
                                + enc(t('Notes')) + '</div>'
                                + '<div style="color:var(--anas-muted,gray);">'
                                + ANAS.warningsHtml(notices) + '</div>';
                        }
                        Ext.Msg.alert(t('Backup finished with a warning'), alertBody);
                    } catch (eMsg) {
                        ANAS.warn(warnings.join(' '));
                    }
                }
                loadTasks(view, node);
            },
        });
        ANAS.toast(t('Backup started') + ': ' + name);
    }

    // ---- Enable / Disable (PUT the task with enabled flipped) --------------

    function toggleTask(view, node, rec) {
        if (!rec) {
            return;
        }
        var name = rec.get('name');
        var raw = rec.get('raw') || taskFromRecord(rec);
        var next = !rec.get('enabled');
        var body = {
            name: name,
            repository: repoNameOf(raw) || rec.get('repository'),
            backupId: backupIdOf(raw) || rec.get('backupId'),
            archives: archivesOf(raw),
            mode: modeOf(raw),
            changeDetectionMode: modeOf(raw),
            schedule: raw.schedule || rec.get('schedule'),
            // backup2.9 — the stored kind rides the whole-task PUT verbatim,
            // for the same reason the dialog sends it: a derived-block task
            // must not start claiming `block` on a toggle (its id and group
            // would stop being its own).
            kind: (raw.kind === 'block' || raw.kind === 'files') ? raw.kind : undefined,
            // A toggle rewrites the whole task — carry the notification mode
            // through it, exactly like the retention policy below.
            notify: notifyOf(raw),
            enabled: next,
        };
        var ns = first(raw.namespace, rec.get('namespace'));
        if (ns) {
            body.namespace = ns;
        }
        // Carry the retention policy through an enable/disable — a toggle must
        // never silently drop it (the PUT rewrites the whole task).
        var keeps = retentionOf(raw);
        if (hasKeeps(keeps)) {
            body.retention = keeps;
        }
        // The structured cadence rides too — dropping it here would keep the
        // generated weekly OnCalendar but silently discard a biweekly task's
        // parity gate (the daemon regenerates from cadence when present).
        var cad = cadenceOf(raw);
        if (cad) {
            body.cadence = cad;
        }
        // And so does LimitNOFILE — the dialog never shows it, so a toggle is
        // the easiest place to lose it (the PUT rewrites the whole task and the
        // schema default would silently re-cap the unit at 1024).
        var lim = limitNofileOf(raw);
        if (lim !== undefined) {
            body.limitNofile = lim;
        }
        ANAS.runJob({
            node: node,
            method: 'put',
            path: '/backup/tasks/' + encodeURIComponent(name),
            body: body,
            view: gridOf(view),
            failTitle: 'Update failed',
            successMsg: next ? (t('Task enabled') + ': ' + name) : (t('Task disabled') + ': ' + name),
            onComplete: function () {
                loadTasks(view, node);
            },
        });
    }

    // ---- Delete (removes the units only; PBS data untouched) ---------------

    function deleteTask(view, node, rec) {
        if (!rec) {
            return;
        }
        var name = rec.get('name');
        try {
            Ext.Msg.confirm(
                t('Delete Backup Task'),
                t('Delete the backup task') + ' "' + enc(name) + '"? '
                    + t('This removes the schedule (its systemd units) only — '
                        + 'snapshots already on the PBS server are kept.'),
                function (btn) {
                    if (btn !== 'yes') {
                        return;
                    }
                    ANAS.confirmAndRun({
                        node: node,
                        method: 'del',
                        path: '/backup/tasks/' + encodeURIComponent(name),
                        view: gridOf(view),
                        confirmTitle: 'Delete backup task',
                        confirmIntro: t('This task cannot be deleted yet:'),
                        failTitle: 'Delete failed',
                        successMsg: t('Backup task deleted') + ': ' + name,
                        onComplete: function () {
                            loadTasks(view, node);
                        },
                    });
                }
            );
        } catch (e) {
            ANAS.warn('backup delete confirm failed: ' + ANAS.errText(e));
        }
    }

    // ======================================================================
    //  Repositories manager — 'anas-win-backup-repos'
    // ======================================================================

    function fpShort(fp) {
        var s = '' + (fp == null ? '' : fp);
        if (!s) {
            return '';
        }
        return s.length > 26 ? (s.substring(0, 26) + '…') : s;
    }

    function selectedRepo(grid) {
        var sel = grid ? grid.getSelection() : [];
        return (sel && sel.length) ? sel[0] : null;
    }

    function renderRepoEndpoint(v, meta, rec) {
        var host = rec.get('host') || '';
        var port = rec.get('port') || PBS_PORT;
        return '<span style="font-family:monospace;font-size:0.9em;" title="' + enc(host + ':' + port) + '">'
            + enc(host + ':' + port) + '</span>';
    }

    function renderRepoDatastore(v, meta, rec) {
        var ds = rec.get('datastore') || '';
        var ns = rec.get('namespace') || '';
        if (!ds) {
            return '<span style="color:gray;">&mdash;</span>';
        }
        var out = '<span style="font-family:monospace;font-size:0.9em;">' + enc(ds) + '</span>';
        if (ns) {
            out += ' <span style="color:var(--anas-muted,gray);font-size:0.85em;">/ ' + enc(ns) + '</span>';
        }
        return out;
    }

    function renderRepoAuth(v, meta, rec) {
        var type = ('' + (rec.get('authType') || 'token')).toLowerCase();
        var identity = type === 'token' ? rec.get('tokenId') : rec.get('username');
        var typeLabel = type === 'token' ? t('API token') : t('User/password');
        var credOk = rec.get('credentialsSet') === true;
        var credChip = credOk
            ? '<span style="color:var(--anas-ok,#1f9c56);" title="' + enc(t('a secret is stored')) + '">'
                + '<i class="fa fa-key"></i></span>'
            : '<span style="color:var(--anas-warn,#b06a12);" title="'
                + enc(t('no secret stored yet — set one before running')) + '"><i class="fa fa-exclamation-triangle"></i></span>';
        var idHtml = identity ? (' <span style="font-family:monospace;font-size:0.85em;color:var(--anas-muted,gray);">'
            + enc(identity) + '</span>') : '';
        return credChip + ' ' + enc(typeLabel) + idHtml;
    }

    function renderRepoFingerprint(v, meta, rec) {
        var fp = rec.get('fingerprint');
        if (!fp) {
            return '<span style="color:var(--anas-warn,#b06a12);" title="'
                + enc(t('certificate fingerprint not pinned yet')) + '">' + enc(t('not pinned')) + '</span>';
        }
        return '<span style="font-family:monospace;font-size:0.82em;" title="' + enc(fp) + '">'
            + enc(fpShort(fp)) + '</span>';
    }

    function repoTestChip(stage) {
        stage = '' + (stage || '');
        if (!stage) {
            return '<span style="color:gray;">&mdash;</span>';
        }
        var good = stage === 'ok';
        var color = good ? 'var(--anas-ok,#1f9c56)'
            : (stage === 'tls-fingerprint' || stage === 'datastore' || stage === 'namespace'
                ? 'var(--anas-warn,#b06a12)' : 'var(--anas-danger,#c23b2c)');
        var label = good ? t('ok') : stage;
        return '<span title="' + enc(label) + '"'
            + ' style="display:inline-block;padding:1px 8px;border-radius:9px;font-size:0.82em;'
            + 'color:' + color + ';background:color-mix(in srgb,' + color + ' 15%,transparent);">'
            + enc(label) + '</span>';
    }

    function renderRepoTestChip(v, meta, rec) {
        return repoTestChip(rec.get('testStage'));
    }

    // Name cell: the repo name, with a PVE badge for a tier-1 (hands-off) repo.
    function renderRepoName(v, meta, rec) {
        var name = '' + (v == null ? '' : v);
        var cell = '<span title="' + enc(name) + '">' + enc(name) + '</span>';
        if (isPveRepo(rec)) {
            cell += ' <span class="anas-badge-pve" title="'
                + enc(t('Defined by Proxmox in storage.cfg — manage it in Datacenter → Storage. '
                    + 'ANAS uses it read-only and reads its credential only when running or testing.'))
                + '" style="display:inline-block;padding:0 6px;border-radius:8px;font-size:0.78em;'
                + 'color:var(--anas-accent,#3468c0);'
                + 'background:color-mix(in srgb,var(--anas-accent,#3468c0) 15%,transparent);">'
                + enc(t('PVE')) + '</span>';
        }
        return cell;
    }

    function updateRepoButtons(grid) {
        if (!grid) {
            return;
        }
        var rec = selectedRepo(grid);
        var has = !!rec;
        var pve = isPveRepo(rec);
        // Test works for every repo; Edit/Delete are locked out on a PVE repo
        // (hands-off — ANAS never writes storage.cfg or the .pw file).
        var setBtn = function (id, disabled, tip) {
            var btn = grid.down('#' + id);
            if (!btn) { return; }
            btn.setDisabled(disabled);
            try { btn.setTooltip(tip || ''); } catch (e) { /* non-fatal */ }
        };
        var handsOff = t('This repository is defined by Proxmox (storage.cfg) — '
            + 'edit it in Datacenter → Storage.');
        setBtn('repoTest', !has, '');
        setBtn('repoEdit', !has || pve, pve ? handsOff : '');
        setBtn('repoDelete', !has || pve, pve ? handsOff : '');
    }

    function reloadRepos(win, node) {
        if (!win || win.destroyed || win.destroying) {
            return;
        }
        var grid = win.down('#reposGrid');
        if (grid) {
            try { grid.setLoading(true); } catch (e) { /* non-fatal */ }
        }
        ANAS.api.get(node, '/backup/repos').then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            if (grid) {
                try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
            }
            var env = reposEnvelope(res);
            win._registryVersion = env.version;
            // Preserve per-row test results across a reload by name.
            var prev = {};
            try {
                grid.getStore().each(function (r) {
                    if (r.get('testStage')) {
                        prev[r.get('name')] = r.get('testStage');
                    }
                });
            } catch (ePrev) {
                // best-effort
            }
            var rows = [];
            for (var i = 0; i < env.repos.length; i++) {
                var row = repoRow(env.repos[i]);
                if (prev[row.name]) {
                    row.testStage = prev[row.name];
                }
                rows.push(row);
            }
            try {
                grid.getStore().loadData(rows);
            } catch (eLoad) {
                ANAS.warn('backup repos grid load failed: ' + ANAS.errText(eLoad));
            }
            updateRepoButtons(grid);
        }, function (err) {
            if (win.destroyed || win.destroying) {
                return;
            }
            if (grid) {
                try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
            }
            ANAS.warn('backup repos load failed: ' + ANAS.errText(err));
            ANAS.alertMsg('Load failed', t('Failed to load the repositories registry') + ': ' + ANAS.errText(err));
        });
    }

    // Test a REGISTERED repo (by name — the daemon uses its stored secret).
    function testRepoRow(node, grid, rec) {
        if (!rec) {
            return;
        }
        var name = rec.get('name');
        try { grid.setLoading(t('Testing') + ' ' + name + '…'); } catch (e) { /* non-fatal */ }
        ANAS.api.post(node, '/backup/repos/test', { name: name }).then(
            function (res) {
                try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
                if (grid.destroyed || grid.destroying) {
                    return;
                }
                var d = (res && res.data) || {};
                rec.set('testStage', '' + (first(d.stage, d.verdict) || 'ok'));
            },
            function (err) {
                try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
                if (grid.destroyed || grid.destroying) {
                    return;
                }
                ANAS.warn('backup repo test failed: ' + ANAS.errText(err));
                rec.set('testStage', 'tcp');
            }
        );
    }

    function deleteRepo(node, win, rec) {
        if (!rec) {
            return;
        }
        var name = rec.get('name');
        try {
            Ext.Msg.confirm(
                t('Delete Repository'),
                t('Unregister the repository') + ' "' + enc(name) + '"? '
                    + t('This removes it from the cluster registry and deletes its stored secret. '
                        + 'Data on the PBS server is untouched.'),
                function (btn) {
                    if (btn !== 'yes') {
                        return;
                    }
                    var ver = win._registryVersion;
                    ANAS.casWrite({
                        node: node,
                        method: 'del',
                        path: '/backup/repos/' + encodeURIComponent(name)
                            + '?expectedVersion=' + encodeURIComponent(ver),
                        view: win,
                        failTitle: 'Delete failed',
                        successMsg: t('Repository deleted') + ': ' + name,
                        onComplete: function () { reloadRepos(win, node); },
                        onConflict: function () {
                            reloadRepos(win, node);
                            ANAS.toast(t('registry changed on another node — reloaded, please retry'));
                        },
                        // A "referenced by a task" refusal (or any non-CAS error)
                        // surfaces the daemon's message verbatim.
                        onError: function (err) {
                            ANAS.alertMsg('Delete failed', ANAS.errText(err));
                        },
                    });
                }
            );
        } catch (e) {
            ANAS.warn('backup repo delete confirm failed: ' + ANAS.errText(e));
        }
    }

    function openReposManager(node) {
        var store = Ext.create('Ext.data.Store', {
            fields: ['name', 'host', 'port', 'datastore', 'namespace', 'authType',
                'tokenId', 'username', 'fingerprint', 'source',
                { name: 'credentialsSet', type: 'auto' },
                'testStage', { name: 'raw', type: 'auto' }],
            data: [],
            sorters: [{ property: 'name', direction: 'ASC' }],
        });

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-backup-repos',
                title: t('Backup Repositories'),
                modal: true,
                width: 760,
                height: 460,
                resizable: true,
                layout: 'fit',
                items: [{
                    xtype: 'gridpanel',
                    itemId: 'reposGrid',
                    cls: 'anas-grid-backup-repos',
                    border: false,
                    store: store,
                    selModel: { mode: 'SINGLE' },
                    emptyText: t('No repositories registered'),
                    columns: [
                        { text: t('Name'), dataIndex: 'name', width: 160, renderer: renderRepoName },
                        { text: t('Host:Port'), dataIndex: 'host', width: 190,
                            sortable: false, menuDisabled: true, renderer: renderRepoEndpoint },
                        { text: t('Datastore'), dataIndex: 'datastore', width: 160,
                            sortable: false, menuDisabled: true, renderer: renderRepoDatastore },
                        { text: t('Auth'), dataIndex: 'authType', flex: 1, minWidth: 150,
                            sortable: false, menuDisabled: true, renderer: renderRepoAuth },
                        { text: t('Fingerprint'), dataIndex: 'fingerprint', width: 150,
                            sortable: false, menuDisabled: true, renderer: renderRepoFingerprint },
                        { text: t('Test'), dataIndex: 'testStage', width: 120, align: 'center',
                            sortable: false, menuDisabled: true, renderer: renderRepoTestChip },
                    ],
                    tbar: ANAS.tbar([
                        {
                            text: t('Add…'),
                            cls: 'anas-btn-backup-repo-add',
                            iconCls: 'fa fa-plus',
                            handler: function () { openRepoEdit(node, win, null); },
                        },
                        {
                            text: t('Edit'),
                            itemId: 'repoEdit',
                            cls: 'anas-btn-backup-repo-edit',
                            iconCls: 'fa fa-pencil',
                            disabled: true,
                            handler: function (btn) {
                                var rec = selectedRepo(btn.up('grid'));
                                openRepoEdit(node, win, rec ? (rec.get('raw') || rec.getData()) : null);
                            },
                        },
                        {
                            text: t('Test'),
                            itemId: 'repoTest',
                            cls: 'anas-btn-backup-repo-test',
                            iconCls: 'fa fa-plug',
                            disabled: true,
                            handler: function (btn) {
                                var grid = btn.up('grid');
                                testRepoRow(node, grid, selectedRepo(grid));
                            },
                        },
                        {
                            text: t('Delete'),
                            itemId: 'repoDelete',
                            cls: 'anas-btn-backup-repo-delete',
                            iconCls: 'fa fa-trash',
                            disabled: true,
                            handler: function (btn) {
                                deleteRepo(node, win, selectedRepo(btn.up('grid')));
                            },
                        },
                    ]),
                    listeners: {
                        selectionchange: function () {
                            updateRepoButtons(this);
                        },
                        itemdblclick: function (grid, rec) {
                            // A PVE-defined repo is hands-off — double-click can't edit it.
                            if (isPveRepo(rec)) {
                                ANAS.toast(t('This repository is defined by Proxmox (storage.cfg) — '
                                    + 'edit it in Datacenter → Storage.'));
                                return;
                            }
                            openRepoEdit(node, win, rec ? (rec.get('raw') || rec.getData()) : null);
                        },
                    },
                }],
                buttons: [
                    { text: t('Close'), handler: function () { win.close(); } },
                ],
            });
        } catch (e) {
            ANAS.warn('backup repos manager window failed: ' + ANAS.errText(e));
            return;
        }

        win._reload = function () { reloadRepos(win, node); };
        win.show();
        reloadRepos(win, node);
    }

    ANAS.backup.openRepos = openReposManager;

    // ======================================================================
    //  Add / edit repository dialog — 'anas-win-backup-repo-edit'
    // ======================================================================

    // Distinct test verdicts (the diagnosis, not just pass/fail).
    var REPO_VERDICT = {
        ok: { level: 'ok', msg: 'Reachable, authenticated, datastore and namespace verified — you can save.' },
        dns: { level: 'bad', msg: 'DNS — the hostname does not resolve.' },
        tcp: { level: 'bad', msg: 'TCP — cannot reach the host on that port (is PBS listening?).' },
        'tls-fingerprint': { level: 'warn',
            msg: 'Certificate is not yet trusted — confirm the fingerprint below before saving.' },
        auth: { level: 'bad',
            msg: 'Authentication failed — check the token id/secret or the username/password.' },
        datastore: { level: 'warn', msg: 'Datastore not found on the server.' },
        namespace: { level: 'warn', msg: 'Namespace not found in the datastore.' },
    };

    function applyAuthType(win, type) {
        try {
            var tokenFs = win.down('#tokenAuth');
            var passFs = win.down('#passwordAuth');
            if (tokenFs) { tokenFs.setHidden(type !== 'token'); }
            if (passFs) { passFs.setHidden(type !== 'password'); }
        } catch (e) {
            ANAS.warn('backup auth toggle failed: ' + ANAS.errText(e));
        }
    }

    // Build the write-shape repo body from the dialog (secret omitted when blank).
    function repoBodyFromDialog(win) {
        var authType = 'token';
        try {
            var ag = win.down('#authGroup');
            var av = ag && ag.getValue();
            if (av && av.authType) {
                authType = av.authType;
            }
        } catch (e) {
            // token stands
        }
        var repo = {
            name: trim(valOf(win, '#name')),
            host: trim(valOf(win, '#host')),
            port: parseInt(valOf(win, '#port'), 10) || PBS_PORT,
            datastore: trim(valOf(win, '#datastore')),
            authType: authType,
            fingerprint: trim(valOf(win, '#fingerprint')),
        };
        var ns = trim(valOf(win, '#namespace'));
        if (ns) {
            repo.namespace = ns;
        }
        if (authType === 'token') {
            repo.tokenId = trim(valOf(win, '#tokenId'));
            var ts = valOf(win, '#tokenSecret');
            if (ts) {
                repo.secret = ts; // write-only; blank = unchanged on edit
            }
        } else {
            repo.username = trim(valOf(win, '#username'));
            var pw = valOf(win, '#password');
            if (pw) {
                repo.secret = pw;
            }
        }
        return repo;
    }

    function renderRepoTestResult(win, node, data) {
        var area = win.down('#testResult');
        if (!area) {
            return;
        }
        data = data || {};
        var stage = '' + (first(data.stage, data.verdict) || 'tcp');
        var spec = REPO_VERDICT[stage] || { level: 'warn', msg: stage };
        var color = spec.level === 'bad' ? 'var(--anas-danger,#c23b2c)'
            : spec.level === 'warn' ? 'var(--anas-warn,#b06a12)' : 'var(--anas-ok,#1f9c56)';
        var text = t(spec.msg) + (data.detail ? (' — ' + data.detail) : '');
        var items = [];
        if (ANAS.gfx && gfxReady() && typeof ANAS.gfx.callout === 'function') {
            items.push({ xtype: 'component', html: ANAS.gfx.callout(enc(text), { level: spec.level }) });
        } else {
            items.push({ xtype: 'component',
                html: '<span style="color:' + color + ';">' + enc(text) + '</span>' });
        }
        // Fingerprint confirmation: shown for EXPLICIT confirmation (no silent
        // trust). Confirming copies it into the field so the next test passes.
        if (stage === 'tls-fingerprint' && data.fingerprint) {
            items.push({
                xtype: 'component',
                margin: '6 0 0 0',
                html: '<div style="font-family:monospace;font-size:12px;padding:6px 8px;'
                    + 'background:rgba(127,127,127,0.1);border-radius:6px;word-break:break-all;">'
                    + enc(data.fingerprint) + '</div>',
            });
            items.push({
                xtype: 'button',
                cls: 'anas-btn-backup-repo-trust',
                text: t('Confirm & use this fingerprint'),
                iconCls: 'fa fa-check',
                margin: '4 0 0 0',
                handler: function () {
                    var fp = win.down('#fingerprint');
                    if (fp) {
                        fp.setValue(data.fingerprint);
                    }
                    runRepoTest(win, node);
                },
            });
        }
        try {
            area.removeAll();
            area.add(items);
        } catch (e) {
            ANAS.warn('backup repo test render failed: ' + ANAS.errText(e));
        }
    }

    function runRepoTest(win, node) {
        var host = trim(valOf(win, '#host'));
        var datastore = trim(valOf(win, '#datastore'));
        if (!host || !datastore) {
            ANAS.alertMsg('Invalid input', t('Enter a host and a datastore to test.'));
            return;
        }
        var area = win.down('#testResult');
        if (area) {
            try {
                area.removeAll();
                area.add({
                    xtype: 'component',
                    html: '<span style="color:var(--anas-muted,gray);">'
                        + '<i class="fa fa-refresh fa-spin" style="margin-right:6px;"></i>'
                        + enc(t('testing connection…')) + '</span>',
                });
            } catch (e) {
                // non-fatal
            }
        }
        ANAS.api.post(node, '/backup/repos/test', repoBodyFromDialog(win)).then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            renderRepoTestResult(win, node, (res && res.data) || {});
        }, function (err) {
            if (win.destroyed || win.destroying) {
                return;
            }
            ANAS.warn('backup repo test failed: ' + ANAS.errText(err));
            renderRepoTestResult(win, node, { stage: 'tcp', detail: ANAS.errText(err) });
        });
    }

    function openRepoEdit(node, mgrWin, existing) {
        var isEdit = !!existing;
        var r = existing || {};
        var authType = ('' + (first(r.authType, r.auth) || 'token')).toLowerCase();

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-backup-repo-edit',
                title: isEdit ? (t('Edit Repository') + ': ' + (r.name || '')) : t('Add Repository'),
                modal: true,
                width: 520,
                height: 640,
                resizable: true,
                layout: 'fit',
                items: [{
                    xtype: 'form',
                    itemId: 'form',
                    bodyPadding: 12,
                    border: false,
                    scrollable: true,
                    defaults: { anchor: '100%', labelWidth: 140 },
                    items: [
                        {
                            xtype: 'textfield',
                            itemId: 'name',
                            cls: 'anas-fld-backup-repo-name',
                            fieldLabel: t('Name'),
                            emptyText: 'pbs-offsite',
                            disabled: isEdit,
                            allowBlank: false,
                            value: r.name || '',
                            regex: NAME_RE,
                            maxLength: 64,
                            regexText: t('Lowercase letters, digits and hyphens; must start with a letter or digit.'),
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'host',
                            cls: 'anas-fld-backup-repo-host',
                            fieldLabel: t('Host'),
                            emptyText: 'pbs.example.com',
                            allowBlank: false,
                            value: r.host || '',
                        },
                        {
                            xtype: 'numberfield',
                            itemId: 'port',
                            cls: 'anas-fld-backup-repo-port',
                            fieldLabel: t('Port'),
                            minValue: 1,
                            maxValue: 65535,
                            value: r.port || PBS_PORT,
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'datastore',
                            cls: 'anas-fld-backup-repo-datastore',
                            fieldLabel: t('Datastore'),
                            emptyText: 'store1',
                            allowBlank: false,
                            value: r.datastore || '',
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'namespace',
                            cls: 'anas-fld-backup-repo-namespace',
                            fieldLabel: t('Namespace (optional)'),
                            emptyText: t('(datastore root)'),
                            value: first(r.namespace) || '',
                        },
                        {
                            xtype: 'fieldset',
                            title: t('Authentication'),
                            collapsible: false,
                            defaults: { anchor: '100%', labelWidth: 140 },
                            items: [
                                {
                                    xtype: 'radiogroup',
                                    itemId: 'authGroup',
                                    cls: 'anas-fld-backup-auth',
                                    columns: 1,
                                    items: [
                                        {
                                            boxLabel: t('API token (recommended — scoped, revocable)'),
                                            name: 'authType', inputValue: 'token',
                                            checked: authType !== 'password',
                                        },
                                        {
                                            boxLabel: t('Username + password'),
                                            name: 'authType', inputValue: 'password',
                                            checked: authType === 'password',
                                        },
                                    ],
                                    listeners: {
                                        change: function (f) {
                                            var w = f.up('window');
                                            if (w) {
                                                var v = f.getValue();
                                                applyAuthType(w, v && v.authType ? v.authType : 'token');
                                            }
                                        },
                                    },
                                },
                                {
                                    xtype: 'fieldcontainer',
                                    itemId: 'tokenAuth',
                                    layout: 'anchor',
                                    hidden: authType === 'password',
                                    defaults: { anchor: '100%', labelWidth: 140 },
                                    items: [
                                        {
                                            xtype: 'textfield',
                                            itemId: 'tokenId',
                                            cls: 'anas-fld-backup-tokenid',
                                            fieldLabel: t('Token ID'),
                                            inputAttrTpl: ANAS.noAutofill.user.inputAttrTpl,
                                            emptyText: 'root@pam!anas',
                                            value: first(r.tokenId, r.tokenid) || '',
                                        },
                                        {
                                            xtype: 'textfield',
                                            itemId: 'tokenSecret',
                                            cls: 'anas-fld-backup-tokensecret',
                                            fieldLabel: t('Token secret'),
                                            inputType: 'password',
                                            inputAttrTpl: ANAS.noAutofill.secret.inputAttrTpl,
                                            emptyText: isEdit ? t('(unchanged)') : t('the token\'s secret value'),
                                        },
                                    ],
                                },
                                {
                                    xtype: 'fieldcontainer',
                                    itemId: 'passwordAuth',
                                    layout: 'anchor',
                                    hidden: authType !== 'password',
                                    defaults: { anchor: '100%', labelWidth: 140 },
                                    items: [
                                        {
                                            xtype: 'textfield',
                                            itemId: 'username',
                                            cls: 'anas-fld-backup-username',
                                            fieldLabel: t('Username'),
                                            inputAttrTpl: ANAS.noAutofill.user.inputAttrTpl,
                                            emptyText: 'root@pam',
                                            value: first(r.username, r.user) || '',
                                        },
                                        {
                                            xtype: 'textfield',
                                            itemId: 'password',
                                            cls: 'anas-fld-backup-password',
                                            fieldLabel: t('Password'),
                                            inputType: 'password',
                                            inputAttrTpl: ANAS.noAutofill.secret.inputAttrTpl,
                                            emptyText: isEdit ? t('(unchanged)') : '',
                                        },
                                    ],
                                },
                                {
                                    xtype: 'component',
                                    style: 'color:var(--anas-muted,gray);font-size:11px;margin-top:4px;',
                                    html: enc(t('The secret is stored in a root-only file on this node and '
                                        + 'injected via the environment — never on the command line. It is '
                                        + 'write-only: it is never shown back, and left blank on edit it is '
                                        + 'kept unchanged.')),
                                },
                            ],
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'fingerprint',
                            cls: 'anas-fld-backup-fingerprint',
                            fieldLabel: t('Cert fingerprint'),
                            emptyText: t('paste or confirm via Test — SHA-256'),
                            fieldStyle: 'font-family:monospace;font-size:12px;',
                            value: first(r.fingerprint, r.certFingerprint) || '',
                        },
                        {
                            xtype: 'component',
                            style: 'color:var(--anas-muted,gray);font-size:11px;margin:-4px 0 8px 144px;',
                            html: enc(t('The PBS certificate fingerprint is pinned explicitly — no silent '
                                + 'trust. Paste it, or run Test and confirm the one it shows.')),
                        },
                        {
                            xtype: 'button',
                            cls: 'anas-btn-backup-repo-testconn',
                            text: t('Test connection'),
                            iconCls: 'fa fa-plug',
                            width: 160,
                            margin: '2 0 0 0',
                            handler: function () { runRepoTest(win, node); },
                        },
                        {
                            xtype: 'container',
                            itemId: 'testResult',
                            cls: 'anas-backup-repo-test',
                            margin: '10 0 0 0',
                            layout: { type: 'vbox', align: 'stretch' },
                            minHeight: 24,
                            items: [{
                                xtype: 'component',
                                html: '<span style="color:var(--anas-muted,gray);font-size:12px;">'
                                    + enc(t('Test diagnoses each step: DNS, TCP, TLS fingerprint, auth, '
                                        + 'datastore and namespace.')) + '</span>',
                            }],
                        },
                    ],
                }],
                buttons: [
                    { text: t('Cancel'), handler: function () { win.close(); } },
                    {
                        text: isEdit ? t('Save') : t('Add'),
                        cls: 'anas-btn-backup-repo-save',
                        handler: function () {
                            try {
                                submitRepo(win, node, mgrWin, isEdit);
                            } catch (e) {
                                ANAS.warn('backup repo save failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('backup repo edit window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
        applyAuthType(win, authType);
    }

    function submitRepo(win, node, mgrWin, isEdit) {
        var form = win.down('#form');
        var basicForm = form && form.getForm();
        if (basicForm && basicForm.isValid && !basicForm.isValid()) {
            return;
        }
        var repo = repoBodyFromDialog(win);
        if (!NAME_RE.test(repo.name) || repo.name.length > 64) {
            ANAS.alertMsg('Invalid input',
                t('Name must be lowercase letters, digits and hyphens (≤64 chars).'));
            return;
        }
        if (!repo.host) {
            ANAS.alertMsg('Invalid input', t('Enter a host.'));
            return;
        }
        if (!repo.datastore) {
            ANAS.alertMsg('Invalid input', t('Enter a datastore.'));
            return;
        }
        // On CREATE a secret is required (nothing stored yet); on edit blank = keep.
        if (!isEdit && !repo.secret) {
            ANAS.alertMsg('Invalid input', repo.authType === 'token'
                ? t('Enter the token secret.') : t('Enter the password.'));
            return;
        }
        var expectedVersion = mgrWin && mgrWin._registryVersion !== undefined
            ? mgrWin._registryVersion : 0;
        var body = { repo: repo, expectedVersion: expectedVersion };

        ANAS.casWrite({
            node: node,
            method: isEdit ? 'put' : 'post',
            path: isEdit ? ('/backup/repos/' + encodeURIComponent(repo.name)) : '/backup/repos',
            body: body,
            view: win,
            failTitle: isEdit ? 'Save failed' : 'Add failed',
            successMsg: isEdit ? (t('Repository saved') + ': ' + repo.name)
                : (t('Repository added') + ': ' + repo.name),
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                if (mgrWin && mgrWin._reload) {
                    mgrWin._reload();
                }
            },
            onConflict: function () {
                if (mgrWin && mgrWin._reload) {
                    mgrWin._reload();
                }
                ANAS.toast(t('registry changed on another node — reloaded, please retry'));
            },
        });
    }

    // ======================================================================
    //  Poll loop control (visibility-gated; no leaked intervals)
    // ======================================================================

    function startPolling(view, node) {
        var grid = gridOf(view);
        if (!grid || grid.destroyed || grid.destroying) {
            return;
        }
        stopPolling(view);
        try {
            view._anasTimer = setInterval(function () {
                try {
                    var g = gridOf(view);
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
                    loadTasks(view, node, true);
                } catch (tickErr) {
                    ANAS.warn('backup poll tick failed: ' + ANAS.errText(tickErr));
                }
            }, POLL_MS);
        } catch (e) {
            ANAS.warn('backup interval start failed: ' + ANAS.errText(e));
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

    // ======================================================================
    //  View
    // ======================================================================

    function backupView(node) {
        var store = Ext.create('Ext.data.Store', {
            fields: [
                'name', 'repository', 'datastore', 'namespace', 'backupId',
                { name: 'kind', type: 'auto' },
                { name: 'storedKind', type: 'auto' },
                { name: 'lunName', type: 'auto' },
                'schedule', 'mode', 'notify', 'lastRunResult', 'lastRunAt', 'nextRunAt',
                { name: 'archiveCount', type: 'auto' },
                { name: 'cadence', type: 'auto' },
                { name: 'limitNofile', type: 'auto' },
                { name: 'enabled', type: 'auto' },
                { name: 'overdue', type: 'auto' },
                { name: 'raw', type: 'auto' },
            ],
            data: [],
            sorters: [{ property: 'name', direction: 'ASC' }],
        });

        var tbar = [
            {
                text: t('Reload'),
                cls: 'anas-btn-refresh anas-btn-backup-refresh',
                iconCls: 'fa fa-refresh',
                handler: function (btn) {
                    loadTasks(btn.up('#backupView'), node);
                },
            },
            {
                text: t('New Task…'),
                cls: 'anas-btn-backup-new',
                iconCls: 'fa fa-plus',
                handler: function (btn) {
                    openTaskDialog(btn.up('#backupView'), node, null);
                },
            },
            {
                text: t('Repositories…'),
                cls: 'anas-btn-backup-repos',
                iconCls: 'fa fa-server',
                handler: function () {
                    openReposManager(node);
                },
            },
            {
                // The TASK-LESS restore door (backup2.6): for archives whose
                // task was renamed or deleted. It needs no selection, because
                // the point is that there may be no task to select, and it shows
                // the FULL editable source part.
                text: t('Restore from repository…'),
                itemId: 'backupRestoreRepo',
                cls: 'anas-btn-backup-restore-repo',
                iconCls: 'fa fa-undo',
                handler: function (btn) {
                    openRestoreDialog(btn.up('#backupView'), node, {});
                },
            },
            '-',
            {
                // The SELECTION-DEPENDENT door (operator finding 2026-08-28): a
                // selected TASK already knows repository, namespace, group and
                // the archive homes, so the dialog asks only the point in time
                // — and what is true of the task is true whether it is enabled
                // or disabled (a disabled task still needs its restore path).
                text: t('Restore…'),
                itemId: 'backupRestore',
                cls: 'anas-btn-backup-restore',
                iconCls: 'fa fa-undo',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#backupView');
                    var rec = selectedTask(gridOf(view));
                    if (rec) {
                        openRestoreDialog(view, node, {
                            task: rec.get('raw') || taskFromRecord(rec),
                        });
                    }
                },
            },
            {
                text: t('Run Now'),
                itemId: 'backupRun',
                cls: 'anas-btn-backup-run',
                iconCls: 'fa fa-play-circle',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#backupView');
                    runTask(view, node, selectedTask(gridOf(view)));
                },
            },
            {
                text: t('Details'),
                itemId: 'backupDetails',
                cls: 'anas-btn-backup-details',
                iconCls: 'fa fa-info-circle',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#backupView');
                    var rec = selectedTask(gridOf(view));
                    if (rec) {
                        openTaskDetailWindow(node, rec.get('name'), view);
                    }
                },
            },
            {
                text: t('Edit'),
                itemId: 'backupEdit',
                cls: 'anas-btn-backup-edit',
                iconCls: 'fa fa-pencil',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#backupView');
                    var rec = selectedTask(gridOf(view));
                    openTaskDialog(view, node, rec ? (rec.get('raw') || taskFromRecord(rec)) : null);
                },
            },
            {
                text: t('Disable'),
                itemId: 'backupToggle',
                cls: 'anas-btn-backup-toggle',
                iconCls: 'fa fa-pause',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#backupView');
                    toggleTask(view, node, selectedTask(gridOf(view)));
                },
            },
            {
                text: t('Delete'),
                itemId: 'backupDelete',
                cls: 'anas-btn-backup-delete',
                iconCls: 'fa fa-trash',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#backupView');
                    deleteTask(view, node, selectedTask(gridOf(view)));
                },
            },
        ];

        return {
            xtype: 'panel',
            itemId: 'backupView',
            cls: 'anas-view anas-view-backup',
            title: t('Backup'),
            layout: { type: 'vbox', align: 'stretch' },
            border: false,
            items: [
                {
                    xtype: 'gridpanel',
                    itemId: 'backupGrid',
                    cls: 'anas-grid-backup',
                    flex: 1,
                    border: false,
                    store: store,
                    selModel: { mode: 'SINGLE' },
                    emptyText: t('No backup tasks defined'),
                    columns: [
                        {
                            text: t('Name'), dataIndex: 'name', width: 150,
                            renderer: Ext.String.htmlEncode,
                        },
                        {
                            text: t('Repository'), dataIndex: 'repository',
                            flex: 1, minWidth: 200, sortable: false, menuDisabled: true,
                            renderer: renderRepo,
                        },
                        {
                            text: t('Backup ID'), dataIndex: 'backupId', width: 130,
                            renderer: renderBackupId,
                        },
                        {
                            // backup2.9 — files or block (the effective kind:
                            // a pre-backup2.9 single-image task reads block).
                            text: t('Kind'), dataIndex: 'kind', width: 90,
                            align: 'center', renderer: renderKind,
                        },
                        {
                            // backup2.9 — the LUN's LIVE name for block tasks
                            // (null = no longer resolvable); a dash for files.
                            text: t('LUN'), dataIndex: 'lunName', width: 150,
                            sortable: false, menuDisabled: true,
                            renderer: renderLunName,
                        },
                        {
                            text: t('Archives'), dataIndex: 'archiveCount', width: 100,
                            align: 'center', renderer: renderArchives,
                        },
                        {
                            // Wide enough for a spelled-out cadence ("Every other
                            // week · Tue · 02:00 · even ISO weeks") — never truncated.
                            text: t('Schedule'), dataIndex: 'schedule', width: 260,
                            renderer: renderSchedule,
                        },
                        {
                            text: t('Last run'), dataIndex: 'lastRunResult', width: 170,
                            sortable: false, menuDisabled: true, renderer: renderLastRun,
                        },
                        {
                            text: t('Next run'), dataIndex: 'nextRunAt', width: 110,
                            renderer: renderNextRun,
                        },
                        {
                            text: t('Enabled'), dataIndex: 'enabled', width: 100,
                            align: 'center', renderer: renderEnabled,
                        },
                    ],
                    tbar: ANAS.tbar(tbar),
                    listeners: {
                        selectionchange: function (selModel, selected) {
                            var grid = this;
                            // The anasReloading guard still preserves selection
                            // across a poll refresh (a transient empty
                            // selectionchange must not clear the button state).
                            if (grid.anasReloading && !(selected && selected.length)) {
                                return;
                            }
                            updateButtons(grid);
                        },
                        itemdblclick: function (grid, rec) {
                            openTaskDialog(grid.up('#backupView'), node,
                                rec ? (rec.get('raw') || taskFromRecord(rec)) : null);
                        },
                    },
                },
            ],
            listeners: {
                afterrender: function (view) {
                    loadTasks(view, node);
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
                    loadTasks(view, node);
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


    // ======================================================================
    //  Restore (stories backup2.6, 2.7, 2.10) — 'anas-win-backup-restore'
    //
    //  ONE dialog behind FOUR doors (the second-door ruling: every door opens
    //  this same window with a prefill, never a second implementation):
    //    * "Restore from repository…" on the Backup toolbar — the task-less
    //      door for archives whose task was renamed or deleted. It shows the
    //      FULL editable source part: repository → namespace → group → point
    //      in time → archive.
    //    * the task detail's "Restore…" and the grid's "Restore…" (beside Run
    //      Now) — the task door. `{task}` supplies repository, namespace,
    //      group and the archive live-homes, so the source part collapses to
    //      a read-only summary line and the dialog starts AT the point in
    //      time (the only real choice left).
    //    * the LUN toolbar's "Restore from backup…" — `{lun}`. Same collapse:
    //      "From LUN <name> — group lun-<serial> in <repo>", destination
    //      defaulting to This LUN.
    //
    //  The source part is asked ONLY when it is not already known. On a
    //  pre-filled door it is one summary line; a small "change source…" link
    //  expands the editable fields for the rare case (collapsed by default).
    //
    //  The what/where part FOLLOWS the picked archive's kind:
    //    * `pxar` → the file restore half (backup2.6/2.10): selections, the
    //      two destinations (into the original — a merge, gated for trees /
    //      somewhere else — a directory the operator names; created if new,
    //      or merged into, after the daemon's confirm, if it exists),
    //      ownership toggles, estimate, rate.
    //    * `img` → the image restore half (backup2.7/2.10): This LUN (a block
    //      image is restored WHOLE, exactly its size) or A new LUN… (fresh
    //      backing at the image's size on ANAS's imagined target combo).
    //      This-LUN is available ONLY when the archive's task `lun` record or
    //      the group's `lun-<serial>` id maps to a LIVE LUN on this node —
    //      the LUN list is read once — and the size-equality gate is
    //      unchanged.
    //
    //  The bodies are EXACTLY the two pre-existing shapes — the daemon and
    //  its schemas are untouched. Switching archive kind swaps the half AND
    //  clears the other half's state, so no stale `selections` can ride an
    //  image body and no stale `target.mode` a files body.
    //
    //  What the dialog does NOT do is decide anything about safety. The daemon
    //  owns every refusal and the confirm gate; this screen's job is to say,
    //  before the button is pressed, exactly what is about to happen.
    // ======================================================================

    /**
     * The archives of one snapshot row that a FILE restore may offer — the
     * `pxar` half of a snapshot's archives (the `img` ones have no inside to
     * pick from). The unified dialog lists BOTH kinds and switches its
     * what/where part on whichever archive is picked; these two pure helpers
     * are the one place the split lives.
     */
    function restorableArchives(rows) {
        return archivesOfKind(rows, 'pxar');
    }

    /** The `img` half — a whole-image restore's candidates in a snapshot. */
    function imageArchivesOf(rows) {
        return archivesOfKind(rows, 'img');
    }

    function archivesOfKind(rows, kind) {
        var list = isArray(rows) ? rows : [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var a = list[i] || {};
            if (a.kind === kind && a.archive) {
                out.push(a);
            }
        }
        return out;
    }

    /**
     * The serial a group's identity carries when it IS a LUN's group: a block
     * task's backup-id is `lun-<unit serial>` (backup2.9), so the PBS group
     * `<type>/lun-<serial>` is the LUN's durable identity and survives a rename
     * or a resize. Returns the serial, or '' when the group is not a LUN's.
     */
    function lunSerialOfGroup(group) {
        var m = /^[^/]+\/lun-(.+)$/.exec('' + (group == null ? '' : group));
        return m ? m[1] : '';
    }

    /** The logical size of one archive in a snapshot row — the space estimate. */
    function archiveBytes(rows, archive) {
        var list = isArray(rows) ? rows : [];
        for (var i = 0; i < list.length; i++) {
            if ((list[i] || {}).archive === archive && typeof list[i].size === 'number') {
                return list[i].size;
            }
        }
        return undefined;
    }

    /** Does this selection hold a DIRECTORY? (the picker knows; a path does not) */
    function hasDirectorySelection(rows) {
        var list = isArray(rows) ? rows : [];
        for (var i = 0; i < list.length; i++) {
            if ((list[i] || {}).type === 'dir') {
                return true;
            }
        }
        return false;
    }

    /**
     * Will the daemon ask for a confirm code?
     *
     * Only an IN-PLACE restore whose selection holds a directory. A single
     * explicitly picked file restored in place is not gated — the operator
     * pointed at that file and ticked the box, and that IS the consent.
     *
     * A `newLocation` restore whose chosen directory ALREADY EXISTS is also
     * gated by the daemon (its 409 + confirm code) — but the dialog cannot
     * know from here whether the path exists, so this helper does not
     * predict it; the confirm flow handles either gate the same way. The
     * daemon decides; this only lets the dialog say so in advance.
     */
    function needsConfirm(mode, rows) {
        return mode === 'inPlace' && hasDirectorySelection(rows);
    }

    /**
     * The POST body, built from one plain context object so the contract can be
     * asserted without an ExtJS window.
     *
     * Omission is meaningful: `ns`, `task`, `rate` and every un-ticked ignore
     * flag are simply absent. A restore is one-shot, not stored config, so
     * `false` and absent mean the same thing and the shorter body is the honest
     * one.
     */
    function restoreBody(ctx) {
        var c = ctx || {};
        var mode = c.mode === 'inPlace' ? 'inPlace' : 'newLocation';
        var body = {
            kind: 'files',
            repo: c.repo,
            snapshot: c.snapshot,
            archive: c.archive,
            selections: isArray(c.selections) ? c.selections : [],
            target: { mode: mode },
            options: {},
        };
        if (trim(c.ns)) {
            body.ns = trim(c.ns);
        }
        if (trim(c.task)) {
            body.task = trim(c.task);
        }
        // In `inPlace` the path names the archive's live HOME. In
        // `newLocation` (backup2.10) it IS the destination directory —
        // created if it does not exist, merged into (after the daemon's
        // confirm) if it does — always carried, so the daemon never has
        // to guess.
        var path = mode === 'newLocation' ? trim(c.newPath) : trim(c.home);
        if (path) {
            body.target.path = path;
        }
        var flags = ['ignoreOwnership', 'ignoreAcls', 'ignoreXattrs', 'ignorePermissions'];
        for (var i = 0; i < flags.length; i++) {
            if (c[flags[i]] === true) {
                body.options[flags[i]] = true;
            }
        }
        if (trim(c.rate)) {
            body.rate = trim(c.rate);
        }
        return body;
    }

    /**
     * The POST body of the IMAGE half (backup2.7/2.10), built from one plain
     * context object so the contract can be asserted without an ExtJS window.
     *
     * Exactly today's two shapes: an in-place restore names the LUN to write
     * back (`lun: {targetIqn, index}`) and NO `target`; a new-LUN restore names
     * `target: {mode:'newLun', targetIqn, name, backing}` and NO `lun`. Omission
     * is meaningful: `ns` and `rate` are absent unless set. The daemon's schema
     * refuses both at once, and nothing here can produce both.
     */
    function imageRestoreBody(ctx) {
        var c = ctx || {};
        var body = {
            kind: 'image',
            repo: trim(c.repo),
            snapshot: c.snapshot,
            archive: c.archive,
        };
        if (c.dest === 'newLun') {
            var target = {
                mode: 'newLun',
                targetIqn: trim(c.newLunTargetIqn),
                name: trim(c.newLunName),
            };
            if (c.newLunKind === 'zvol') {
                target.backing = { kind: 'zvol', pool: trim(c.newLunPool) };
            } else {
                target.backing = c.fileSource === 'ahr'
                    ? { kind: 'file', ahrPool: trim(c.filePath) }
                    : { kind: 'file', dataset: trim(c.filePath) };
            }
            body.target = target;
        } else if (c.lun) {
            body.lun = { targetIqn: c.lun.targetIqn, index: c.lun.index };
        }
        // `ns` stays LAST, exactly where backup2.7's dialog put it — the bodies
        // are byte-identical to the pre-unification shapes, key order included.
        if (trim(c.ns)) {
            body.ns = trim(c.ns);
        }
        if (trim(c.rate)) {
            body.rate = trim(c.rate);
        }
        return body;
    }

    /** Trimmed field value — the 68-backup sibling of 75-iscsi's textOf. */
    function textOf(win, sel) {
        var v = valOf(win, sel);
        return ('' + (v === undefined || v === null ? '' : v)).trim();
    }

    function fmtBytes(v) {
        try {
            return ANAS.formatBytes ? ANAS.formatBytes(v) : ('' + v);
        } catch (e) {
            return '' + v;
        }
    }

    /**
     * The target choice from the TWO radios — somewhere else (the default),
     * or into the original (backup2.10, ruling 2026-08-29). Reads the radio
     * group by itemId, never a mirrored flag.
     */
    function restoreTargetMode(win) {
        try {
            var g = win.down('#restoreTargetKind');
            var v = g && g.getValue();
            if (v && (v.restoreTarget === 'inPlace' || v.restoreTarget === 'newLocation')) {
                return v.restoreTarget;
            }
        } catch (e) {
            // fall through to the default
        }
        return 'newLocation';
    }

    /** The dialog's live context — every field read by itemId, never mirrored. */
    function restoreContext(win) {
        return {
            repo: trim(valOf(win, '#restoreRepo')),
            ns: trim(valOf(win, '#restoreNs')),
            task: win._task || '',
            snapshot: trim(valOf(win, '#restoreSnapshot')),
            archive: trim(valOf(win, '#restoreArchive')),
            selections: isArray(win._selections) ? win._selections : [],
            mode: restoreTargetMode(win),
            home: trim(valOf(win, '#restoreHome')),
            newPath: trim(valOf(win, '#restoreNewLocation')),
            ignoreOwnership: valOf(win, '#restoreIgnoreOwnership') === true,
            ignoreAcls: valOf(win, '#restoreIgnoreAcls') === true,
            ignoreXattrs: valOf(win, '#restoreIgnoreXattrs') === true,
            ignorePermissions: valOf(win, '#restoreIgnorePermissions') === true,
            rate: trim(valOf(win, '#restoreRate')),
        };
    }

    function restoreNote(win, itemId, html) {
        try {
            var c = win.down('#' + itemId);
            if (c) {
                c.update(html || '');
            }
        } catch (e) {
            // non-fatal
        }
    }

    function mutedSpan(text) {
        return '<span style="color:var(--anas-muted,gray);font-size:0.9em;">' + enc(text) + '</span>';
    }

    /** Repaint the target line, the estimate and the selection summary. */
    function refreshRestore(win) {
        var ctx = restoreContext(win);
        var rows = isArray(win._selectionRows) ? win._selectionRows : [];

        var selectionHtml;
        if (!ctx.selections.length) {
            selectionHtml = mutedSpan(t('Nothing picked yet.'));
        } else {
            var names = [];
            for (var i = 0; i < ctx.selections.length && i < 12; i++) {
                names.push(enc(ctx.selections[i]));
            }
            selectionHtml = '<span style="font-family:monospace;font-size:0.9em;">' + names.join('<br>') + '</span>';
            if (ctx.selections.length > names.length) {
                selectionHtml += '<br>' + mutedSpan(t('and') + ' ' + (ctx.selections.length - names.length) + ' ' + t('more'));
            }
        }
        restoreNote(win, 'restoreSelectionList', selectionHtml);

        var targetHtml;
        if (ctx.mode === 'inPlace') {
            targetHtml = '<span style="font-family:monospace;">' + enc(ctx.home || '?') + '</span><br>'
                + '<span style="color:var(--anas-warn,#b06a12);font-size:0.9em;">'
                + enc(t('Restored files replace the ones with the same names. This is a MERGE, never a sync: '
                    + 'anything under the target that is not in the backup is left exactly as it is.'))
                + '</span>';
            if (needsConfirm(ctx.mode, rows)) {
                targetHtml += '<br>' + '<span style="color:var(--anas-warn,#b06a12);font-size:0.9em;">'
                    + enc(t('The selection includes a directory, so ANAS will ask you to confirm before it runs.'))
                    + '</span>';
            }
        } else {
            var loc = trim(ctx.newPath);
            targetHtml = loc
                ? '<span style="font-family:monospace;">' + enc(loc) + '</span><br>'
                    + mutedSpan(t('Created by this restore if it does not exist. If it already exists, ANAS will '
                        + 'ask you to confirm and then merge into it: files with the same names are replaced, '
                        + 'everything else is kept.'))
                : mutedSpan(t('Name the directory the restore writes into.'));
        }
        restoreNote(win, 'restoreTargetNote', targetHtml);

        // The new-directory field and its note belong ONLY to the newLocation choice.
        var nlocWrap = win.down('#restoreNewLocationWrap');
        if (nlocWrap) {
            nlocWrap.setHidden(ctx.mode !== 'newLocation');
            nlocWrap.setDisabled(ctx.mode !== 'newLocation');
        }
        var nlocNote = win.down('#restoreNewLocationNote');
        if (nlocNote) {
            nlocNote.setHidden(ctx.mode !== 'newLocation');
        }

        var bytes = archiveBytes(win._archives, ctx.archive);
        restoreNote(win, 'restoreEstimate', bytes === undefined
            ? mutedSpan(t('unknown until a point in time and an archive are picked'))
            : enc(ANAS.formatBytes ? ANAS.formatBytes(bytes) : ('' + bytes))
                + ' ' + mutedSpan(t('— the whole archive; a partial selection needs less')));
    }

    /**
     * Fill the archive combo from the chosen snapshot with BOTH kinds. The
     * what/where part follows whichever archive is picked — pxar → the files
     * half, img → the LUN half — so nothing is filtered here except the
     * bookkeeping files (kind `other`), which are never a restore source.
     *
     * An archive is PRE-SELECTED only when the snapshot holds exactly ONE
     * restorable archive (a block task's whole image is the fixed `disk`); with
     * a real choice the combo is left empty and the part stays hidden until the
     * operator picks.
     */
    function setRestoreArchives(win, archives) {
        win._archives = isArray(archives) ? archives.slice() : [];
        var combo = win.down('#restoreArchive');
        if (!combo) {
            return;
        }
        var data = [];
        for (var i = 0; i < win._archives.length; i++) {
            var a = win._archives[i] || {};
            data.push({
                archive: a.archive,
                label: a.archive + (a.kind === 'img' ? '  (' + t('image') + ')' : ''),
            });
        }
        try {
            combo.getStore().loadData(data);
        } catch (e) {
            // non-fatal
        }
        if (data.length === 1) {
            try {
                combo.setValue(data[0].archive);
            } catch (e2) {
                // non-fatal
            }
        } else if (data.length) {
            try {
                combo.setValue('');
            } catch (e3) {
                // non-fatal
            }
            restoreNote(win, 'restoreArchiveNote',
                '<span style="color:var(--anas-muted,gray);font-size:0.9em;">'
                + enc(t('This snapshot has') + ' ' + data.length + ' '
                    + t('archives — pick one; the restore follows its kind.')) + '</span>');
        } else {
            restoreNote(win, 'restoreArchiveNote', mutedSpan(
                t('This snapshot holds no restorable archive.')));
        }
    }

    /** The KIND of the archive the combo currently names, or '' when none. */
    function currentArchiveKind(win) {
        var archive = trim(valOf(win, '#restoreArchive'));
        if (!archive) {
            return '';
        }
        for (var i = 0; i < win._archives.length; i++) {
            if (win._archives[i].archive === archive) {
                return win._archives[i].kind === 'img' ? 'img' : 'pxar';
            }
        }
        return '';
    }

    /**
     * The archive choice drives the what/where part. Switching kind ALSO clears
     * the other half's state — no stale `selections` may ride an image body, no
     * stale target choice a files body — and the destination re-defaults to
     * This LUN / somewhere else every time the part appears.
     */
    function restoreArchiveChanged(win, node) {
        var kind = currentArchiveKind(win);
        var previous = win._archiveKind || '';
        win._archiveKind = kind;
        if (kind === 'img') {
            // Entering the image half from a DIFFERENT kind (or from nothing):
            // the files state is dropped and the destination re-asks *This LUN*
            // (resolveAndRefreshImage flips it to a new LUN when nothing maps).
            // Moving between two `img` archives stays put — a second image is
            // the same half, and resetting would clear the operator's choices.
            if (previous !== 'img') {
                win._selections = [];
                win._selectionRows = [];
                var filesTarget = win.down('#restoreTargetKind');
                if (filesTarget) {
                    try { filesTarget.setValue({ restoreTarget: 'newLocation' }); } catch (eT) { /* non-fatal */ }
                }
                var destG = win.down('#restoreDest');
                if (destG) {
                    try { destG.setValue({ restoreDest: 'inPlace' }); } catch (eD) { /* non-fatal */ }
                }
                ensureLunInventory(win, node);
                // The task-less door has no pre-filled LUN/task, so the target
                // combo has not been filled yet — the image half needs it.
                loadRestoreTargetChoices(win, node,
                    win._prefillLun ? (win._prefillLun.targetIqn || '') : '');
                // …and the backing pickers ride the same entry (once per
                // dialog — the doors that filled them up front set the flag).
                loadRestoreBackingChoices(win, node);
            }
            resolveAndRefreshImage(win);
        } else if (kind === 'pxar') {
            // Entering the files half from a DIFFERENT kind: image state is
            // dropped on the floor (the destination re-defaults and the new-LUN
            // form clears, so neither can leak a stale value into a files body).
            if (previous !== 'pxar') {
                var dest = win.down('#restoreDest');
                if (dest) {
                    try { dest.setValue({ restoreDest: 'inPlace' }); } catch (eD) { /* non-fatal */ }
                }
                clearNewLunFields(win);
            }
            applyArchiveHome(win);
            refreshRestore(win);
            // Files restores validate on submit; the one dead-button case is a
            // `newLocation` restore without its directory (the gate checks it).
            updateSubmitGate(win, true);
        }
        setRestorePartVisibility(win);
    }

    /** Show only the what/where half the picked archive's kind needs. */
    function setRestorePartVisibility(win) {
        var files = win._archiveKind === 'pxar';
        var image = win._archiveKind === 'img';
        var set = function (sel, visible) {
            var f = win.down(sel);
            if (!f) {
                return;
            }
            f.setHidden(!visible);
            f.setDisabled(!visible);
        };
        set('#restoreFilesWrap', files);
        set('#restoreImageWrap', image);
    }

    /**
     * Follow the chosen archive to ITS live home, when the task door knows one.
     * The field stays editable — a typed path is always first-class — but the
     * dialog never leaves a stale home pointing at a different archive.
     */
    function applyArchiveHome(win) {
        var map = win._homeByArchive || {};
        var home = map[bareArchive(trim(valOf(win, '#restoreArchive')))];
        if (!home) {
            return;
        }
        try {
            var f = win.down('#restoreHome');
            if (f) {
                f.setValue(home);
            }
        } catch (e) {
            // non-fatal
        }
    }

    /**
     * Open the point-in-time picker. A task door that is still COLLAPSED lists
     * the task's OWN group (`/backup/tasks/<name>/snapshots`); once the source
     * has been expanded — or on the task-less / LUN doors — it lists the group
     * the source fields name (`/backup/repos/<repo>/groups?group=`).
     */
    function pickRestoreSnapshot(win, node) {
        if (!ANAS.snapshotPicker) {
            ANAS.warn('snapshot picker unavailable');
            return;
        }
        var ctx = restoreContext(win);
        var cfg = {
            node: node,
            onSelect: function (picked) {
                try {
                    var f = win.down('#restoreSnapshot');
                    if (f) {
                        f.setValue(picked.snapshot);
                    }
                } catch (e) {
                    // non-fatal
                }
                win._selections = [];
                win._selectionRows = [];
                // The listing named the group it read — that is what a LUN's
                // `lun-<serial>` identity and the summary line are keyed on.
                if (picked.group) {
                    win._group = picked.group;
                    win._groupKnown = true;
                }
                setRestoreArchives(win, picked.archives);
                updateRestoreSummary(win);
                // A picked point in time REPLACES any earlier one — including
                // its archives and the part state they chose.
                restoreArchiveChanged(win, node);
            },
        };
        if (win._task && !win._sourceExpanded) {
            cfg.task = win._task;
        } else {
            var group = trim(valOf(win, '#restoreGroup'));
            if (!ctx.repo || !group) {
                // Without a group there is nothing to list: the task-less door
                // exists because no task remembers the name, so say which two
                // things are still missing rather than opening an empty picker.
                restoreNote(win, 'restoreArchiveNote',
                    '<span style="color:var(--anas-warn,#b06a12);">'
                    + enc(t('Choose a repository and a backup group first.')) + '</span>');
                return;
            }
            cfg.repo = ctx.repo;
            if (ctx.ns) {
                cfg.ns = ctx.ns;
            }
            cfg.group = group;
        }
        ANAS.snapshotPicker(cfg);
    }

    /** Open the archive-backed multi-select picker for the chosen archive. */
    function pickRestoreFiles(win, node) {
        if (!ANAS.pathPicker) {
            ANAS.warn('path picker unavailable');
            return;
        }
        var ctx = restoreContext(win);
        if (!ctx.snapshot || !ctx.archive) {
            restoreNote(win, 'restoreSelectionList',
                '<span style="color:var(--anas-warn,#b06a12);">'
                + enc(t('Pick a point in time and an archive first.')) + '</span>');
            return;
        }
        ANAS.pathPicker({
            node: node,
            backend: 'archive',
            mode: 'any',
            multiSelect: true,
            value: '/',
            title: t('Choose what to restore'),
            archive: {
                repo: ctx.repo,
                ns: ctx.ns,
                snapshot: ctx.snapshot,
                archive: ctx.archive,
            },
            onSelect: function (paths, rows) {
                win._selections = isArray(paths) ? paths : [];
                win._selectionRows = isArray(rows) ? rows : [];
                refreshRestore(win);
            },
        });
    }

    /**
     * The newLocation door's directory browser (backup2.10): the SHARED path
     * picker on the LIVE backend, choosing a directory. The typed/struck answer
     * is the path of the NEW directory the restore will create — the picker
     * happily names a directory that does not exist yet; that is the point.
     */
    function pickNewRestoreLocation(win, node) {
        if (!ANAS.pathPicker) {
            ANAS.warn('path picker unavailable');
            return;
        }
        ANAS.pathPicker({
            node: node,
            backend: 'live',
            mode: 'dir',
            title: t('Choose the new directory'),
            onSelect: function (paths) {
                // A SINGLE-select picker hands back the path STRING (the field is
                // authoritative); a multi-select one hands back an array. Both
                // arrive here, and both are the directory the restore creates.
                var picked = isArray(paths) ? paths[0] : paths;
                if (!picked) {
                    return;
                }
                try {
                    var f = win.down('#restoreNewLocation');
                    if (f) {
                        f.setValue(picked);
                    }
                } catch (e) {
                    // non-fatal
                }
                refreshRestore(win);
            },
        });
    }

    /** Submit — route by the picked archive's kind, one dialog, two halves. */
    function submitRestore(win, node) {
        if (currentArchiveKind(win) === 'img') {
            submitRestoreImage(win, node);
            return;
        }
        submitRestoreFiles(win, node);
    }

    /** Submit the FILES half. The daemon owns every refusal; this only sends. */
    function submitRestoreFiles(win, node) {
        var ctx = restoreContext(win);
        if (!ctx.snapshot || !ctx.archive || !ctx.selections.length) {
            restoreNote(win, 'restoreSelectionList',
                '<span style="color:var(--anas-danger,#c23b2c);">'
                + enc(t('Pick a point in time, an archive and at least one entry.')) + '</span>');
            return;
        }
        // A newLocation restore is refused by the daemon without its
        // directory — say it before the button is pressed, in the target line
        // (the button is already dead in this shape; this is the same rule
        // said where the operator is looking).
        if (ctx.mode === 'newLocation' && !ctx.newPath) {
            restoreNote(win, 'restoreTargetNote',
                '<span style="color:var(--anas-danger,#c23b2c);">'
                + enc(t('Name the directory this restore writes into. It is created if it does not '
                    + 'exist; if it already exists, ANAS will ask you to confirm and merge into it.')) + '</span>');
            return;
        }
        ANAS.confirmAndRun({
            node: node,
            method: 'post',
            path: '/backup/restore',
            body: restoreBody(ctx),
            // The poll view is the LONG-LIVED component the dialog was opened
            // from, never the dialog itself: onSubmitted closes `win`, and
            // ANAS.pollJob stops the moment its view is destroyed — a dead
            // view would silence the failure alert and the completion summary.
            view: win._view || win,
            maxMs: 3600000,
            confirmTitle: t('Restore over live data'),
            confirmIntro: t('This restore writes into a directory that already holds data:'),
            confirmButtonText: t('Restore'),
            failTitle: t('Restore failed'),
            successMsg: t('Restore finished'),
            onSubmitted: function () {
                try {
                    win.close();
                } catch (e) {
                    // non-fatal
                }
            },
            onComplete: function (job) {
                var r = job && job.result;
                if (!r) {
                    return;
                }
                var missing = isArray(r.missing) ? r.missing.length : 0;
                var restored = isArray(r.restored) ? r.restored.length : 0;
                var msg = t('Restored') + ' ' + restored + '/' + (restored + missing)
                    + ' ' + t('selected entries into') + ' ' + (r.target || '');
                if (missing) {
                    msg += ' — ' + t('not restored') + ': ' + (r.missing || []).join(', ');
                }
                try {
                    ANAS.alertMsg(t('Restore'), msg);
                } catch (e) {
                    ANAS.toast(msg);
                }
            },
        });
    }

    // ---- The image half (backup2.7 / backup2.10) ---------------------------
    //
    // A whole image is restored WHOLE. The destination choice is This LUN — the
    // block object the source maps to, which must be exactly the image's size —
    // or A new LUN… (backup2.10), where a fresh backing is created AT the
    // image's size and the source LUN is never touched. The live-LUN inventory
    // is read ONCE (per ANAS-owned target's detail the ~first time the img half
    // shows), and "This LUN" is offered only when the picked source maps to a
    // LUN in that inventory through one of the three anchors: the door's own
    // prefill, the task archive's `lun` record, or the group's `lun-<serial>`.

    /** The live LUN inventory, read once. Not collected until the img half needs it. */
    function ensureLunInventory(win, node) {
        return loadLunInventory(win, node);
    }

    function loadLunInventory(win, node) {
        if (win._lunInventoryPromise) {
            return win._lunInventoryPromise;
        }
        win._lunInventoryPromise = ANAS.api.get(node, '/iscsi/targets').then(function (res) {
            var targets = (res && res.data && isArray(res.data.targets)) ? res.data.targets : [];
            var reads = [];
            for (var i = 0; i < targets.length; i++) {
                var t = targets[i] || {};
                if (t.ownership === 'anas' && t.iqn) {
                    reads.push(loadLunTargetDetail(win, node, t.iqn));
                }
            }
            return Promise.all(reads);
        }).then(function (lists) {
            var out = [];
            for (var j = 0; j < lists.length; j++) {
                out = out.concat(isArray(lists[j]) ? lists[j] : []);
            }
            win._lunInventory = out;
            win._lunReceived = true;
            win._lunInventoryPromise = null;
            // The list just landed — a This LUN the earlier rendering could not
            // resolve may be there now, so the whole half re-evaluates.
            resolveAndRefreshImage(win);
            return out;
        }, function () {
            win._lunInventoryPromise = null;
            win._lunReceived = true;
            resolveAndRefreshImage(win);
            return [];
        });
    }

    function loadLunTargetDetail(win, node, iqn) {
        return ANAS.api.get(node, '/iscsi/targets/' + encodeURIComponent(iqn)).then(function (res) {
            if (win.destroyed || win.destroying) {
                return [];
            }
            var d = (res && res.data) || {};
            var luns = isArray(d.luns) ? d.luns : [];
            var out = [];
            for (var i = 0; i < luns.length; i++) {
                var l = luns[i] || {};
                out.push({
                    targetIqn: iqn,
                    index: l.index,
                    name: l.name,
                    kind: l.kind,
                    size: l.size,
                    serial: l.serial,
                    backingPath: l.backingPath,
                    backingExists: l.backingExists,
                    connectedInitiators: isArray(l.connectedInitiators) ? l.connectedInitiators : [],
                });
            }
            return out;
        }, function () {
            return [];
        });
    }

    /**
     * "This LUN" is never invented: it has to RESOLVE from the picked source to
     * a LUN the node is serving right now, through three anchors —
     *   1. the LUN door's own prefill (the LUN the operator selected in the
     *      iSCSI screen),
     *   2. the block task's archive `lun` record,
     *   3. the group's `lun-<serial>` identity (a serial survives a rename).
     * `live` requires a backing ANAS can see AND a known size — without the
     * size there is no equality to prove, and an absent backing has nothing to
     * write onto. Returns the record, or null.
     */
    function resolveThisLun(win) {
        var inv = isArray(win._lunInventory) ? win._lunInventory : [];
        var p = win._prefill && win._prefill.lun;
        var cand = null;
        if (p) {
            cand = p;
        } else if (win._taskLun) {
            cand = win._taskLun;
        } else if (win._group) {
            var serial = lunSerialOfGroup(win._group);
            if (serial) {
                for (var i = 0; i < inv.length; i++) {
                    if (inv[i] && inv[i].serial === serial) {
                        return liveLunMatch(inv[i]) ? inv[i] : null;
                    }
                }
                return null;
            }
        }
        if (!cand) {
            return null;
        }
        for (var j = 0; j < inv.length; j++) {
            var l = inv[j] || {};
            if (l.targetIqn === cand.targetIqn && l.index === cand.index) {
                return liveLunMatch(l) ? l : null;
            }
        }
        return null;
    }

    /** A serving LUN with a backing present and a size to prove equality on. */
    function liveLunMatch(l) {
        return l.backingExists !== false && Number(l.size) > 0;
    }

    /**
     * The in-place verdict, ONE computation for every door (backup2.10
     * fix-up 2026-08-29): the DIALOG applies the shared
     * `ANAS.iscsi.lunInPlace` helper to the LUN it resolves — the toolbar's,
     * the task grid's, the task-Details' and the repository door's alike — so
     * every door says the refusal before the daemon's 409 does. Fails CLOSED:
     * a helper the bundle does not carry (load order, a stale page) disables
     * in place with a generic refusal rather than offering it unverified.
     * `null` when the LUN resolves and the verdict allows it (a LUN that does
     * not resolve at all has its own machinery below).
     */
    function inPlaceRefused(win) {
        var rl = resolveThisLun(win);
        if (!rl) {
            return null;
        }
        if (!ANAS.iscsi || typeof ANAS.iscsi.lunInPlace !== 'function') {
            return {
                allowed: false,
                reason: t('The in-place destination cannot be verified right now — restore it as a NEW '
                    + 'LUN, which touches nothing that is live.')
            };
        }
        var v = ANAS.iscsi.lunInPlace(rl);
        if (v && v.allowed === false) {
            return {
                allowed: false,
                reason: '' + (v.reason || t('This LUN cannot take an in-place restore right now.'))
            };
        }
        return null;
    }

    /** The size of the picked `.img` archive — the image's manifest size. */
    function selectedImageSize(win) {
        var archive = trim(valOf(win, '#restoreArchive'));
        for (var i = 0; i < win._archives.length; i++) {
            var a = win._archives[i] || {};
            if (a.archive === archive && a.kind === 'img') {
                return typeof a.size === 'number' ? a.size : null;
            }
        }
        return null;
    }

    /** The destination choice from the two radios: `inPlace` | `newLun`. */
    function restoreDestMode(win) {
        try {
            var g = win.down('#restoreDest');
            var v = g && g.getValue();
            return (v && v.restoreDest === 'newLun') ? 'newLun' : 'inPlace';
        } catch (e) {
            return 'inPlace';
        }
    }

    /** The new-LUN backing kind from its radio: `zvol` | `file`. */
    function newLunBackingKind(win) {
        try {
            var g = win.down('#newLunKind');
            var v = g && g.getValue();
            return (v && v.lunKind === 'file') ? 'file' : 'zvol';
        } catch (e) {
            return 'zvol';
        }
    }

    /** Show only the fields the chosen new-LUN backing uses, and DISABLE the
     * hidden one so a stale value cannot be read back on submit. */
    function applyNewLunKind(win) {
        var file = newLunBackingKind(win) === 'file';
        var set = function (sel, visible) {
            var f = win.down(sel);
            if (!f) {
                return;
            }
            f.setHidden(!visible);
            f.setDisabled(!visible);
        };
        set('#newLunPool', !file);
        set('#filePicker', file);
    }

    /** Where the picked image file will live — `dataset` or `ahr` (the source flag). */
    function filePickerSource(win, where) {
        try {
            var combo = win.down('#filePicker');
            var store = combo && combo.getStore();
            // exactMatch — the in-repo form: ExtJS's default is a
            // case-insensitive PREFIX match, so a store holding 'ahrpool' and
            // 'ahrpool-snap' would hand back the wrong row's source flag.
            var rec = store && store.findRecord ? store.findRecord('name', where, 0, false, true, true) : null;
            return rec ? (rec.get('source') || 'dataset') : 'dataset';
        } catch (e) {
            return 'dataset';
        }
    }

    /** A name already claimed by a LUN on this node — the node-global check. */
    function lunNameTakenOn(win, name) {
        var inv = isArray(win._lunInventory) ? win._lunInventory : [];
        for (var i = 0; i < inv.length; i++) {
            if (inv[i] && inv[i].name === name) {
                return true;
            }
        }
        return false;
    }

    /** The local validation for the new-LUN form, cheapest checks first. */
    function validateNewLun(win, size) {
        if (!textOf(win, '#restoreSnapshot') || !textOf(win, '#restoreArchive')) {
            return { ok: false, prompt: t('Pick a point in time and an image archive first.') };
        }
        if (size === null || size === undefined) {
            return { ok: false, reason: t('The size of this archive is not in the snapshot manifest, so ANAS '
                + 'cannot create the new backing at the image\'s exact size. The restore is refused without '
                + 'that proof: a backing of the wrong size would be a LUN whose end does not match the image it holds.') };
        }
        if (!textOf(win, '#newLunTarget')) {
            return { ok: false, reason: t('Pick the ANAS-managed target the new LUN appears on.') };
        }
        var name = textOf(win, '#newLunName');
        if (!name) {
            return { ok: false, reason: t('Enter a LUN name.') };
        }
        if (lunNameTakenOn(win, name)) {
            return { ok: false, reason: t('A LUN named') + ' \'' + name + '\' ' + t('already exists on this node. '
                + 'The name is the SCSI model string initiators see, so it has to be unique.') };
        }
        if (newLunBackingKind(win) === 'zvol') {
            if (!textOf(win, '#newLunPool')) {
                return { ok: false, reason: t('Pick the ZFS pool the new volume is created on.') };
            }
        } else if (!textOf(win, '#filePicker')) {
            return { ok: false, reason: t('Pick the dataset or AHR pool the image will live on.') };
        }
        return { ok: true };
    }

    /** The `target` object for a newLun restore, schema-exact. */
    function buildNewLunTarget(win) {
        var target = {
            mode: 'newLun',
            targetIqn: textOf(win, '#newLunTarget'),
            name: textOf(win, '#newLunName'),
        };
        if (newLunBackingKind(win) === 'zvol') {
            target.backing = { kind: 'zvol', pool: textOf(win, '#newLunPool') };
        } else {
            var where = textOf(win, '#filePicker');
            var source = filePickerSource(win, where);
            target.backing = source === 'ahr'
                ? { kind: 'file', ahrPool: where }
                : { kind: 'file', dataset: where };
        }
        return target;
    }

    /** Which panels the operator sees, per destination. Hidden = disabled. */
    function setDestFieldVisibility(win, isNewLun) {
        var set = function (sel, visible) {
            var f = win.down(sel);
            if (!f) {
                return;
            }
            f.setHidden(!visible);
            f.setDisabled(!visible);
        };
        set('#restoreTargetPath', !isNewLun);
        set('#lunSizeWrap', !isNewLun);
        set('#sizeVerdictWrap', !isNewLun);
        set('#newLunFields', isNewLun);
        set('#newLunVerdictWrap', isNewLun);
    }

    /** The in-place verdict — TODAY's gate, byte-for-byte the same wording. */
    function applyInPlaceVerdict(win, lunSize, size) {
        var verdict = win.down('#sizeVerdict');
        var chosen = textOf(win, '#restoreSnapshot') && textOf(win, '#restoreArchive');
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
        return ok;
    }

    /** The new-LUN verdict: the form's validity, and the button's gate. */
    function updateNewLunVerdict(win, size) {
        var verdict = win.down('#newLunVerdict');
        var val = validateNewLun(win, size);
        var ok = false;
        var html;
        if (val.ok) {
            ok = true;
            html = '<span style="color:var(--anas-good,#2e7d32);">'
                + enc(t('Restored as a NEW LUN: the backing is created at exactly the image\'s size ('))
                + enc(fmtBytes(size)) + '). ' + enc(t('The source LUN is untouched and stays online.')) + '</span>';
        } else if (val.prompt) {
            html = '<span style="color:gray;font-size:0.9em;">' + enc(val.prompt) + '</span>';
        } else {
            html = '<span style="color:var(--anas-bad,#c0392b);">' + enc(val.reason) + '</span>';
        }
        if (verdict) {
            verdict.update(html);
        }
        return ok;
    }

    /** The size gate, per destination: in-place EQUALITY, newLun KNOWN-only. */
    function updateRestoreSizes(win) {
        var size = selectedImageSize(win);
        var sizeField = win.down('#imageSize');
        if (sizeField) {
            sizeField.setValue(size === null || size === undefined
                ? '<span style="color:gray;">&mdash;</span>'
                : enc(fmtBytes(size)) + ' (' + enc('' + size) + ' ' + enc(t('bytes')) + ')');
        }
        var isNewLun = restoreDestMode(win) === 'newLun';
        setDestFieldVisibility(win, isNewLun);
        if (!win._lunReceived) {
            return;
        }
        var rl = resolveThisLun(win);
        var ok = isNewLun ? updateNewLunVerdict(win, size) : applyInPlaceVerdict(win, rl ? rl.size : 0, size);
        updateSubmitGate(win, ok);
    }

    /**
     * The image half painted in full: which destination is even possible, which
     * panels are visible, which verdict speaks. Call it whenever the source
     * (group), the archive, or the LUN list changes.
     */
    function resolveAndRefreshImage(win) {
        var rl = resolveThisLun(win);
        // The shared verdict (ANAS.iscsi.lunInPlace — one helper, every door)
        // adds its refusal to the SAME condition: the in-place destination is
        // dead when nothing maps — OR when the LUN it resolves cannot take the
        // overwrite (a live session, an unmanaged backing, an unknown size,
        // or a verdict the bundle could not compute).
        var refused = inPlaceRefused(win);
        var inPlaceDead = !rl || !!refused;
        var dest = win.down('#restoreDest');
        if (dest) {
            var inPlaceRadio = null;
            try {
                var kids = dest.childCmps ? dest.childCmps() : [];
                for (var i = 0; i < kids.length; i++) {
                    if (kids[i].inputValue === 'inPlace') {
                        inPlaceRadio = kids[i];
                    }
                }
            } catch (e) {
                inPlaceRadio = null;
            }
            if (inPlaceRadio) {
                inPlaceRadio.setDisabled(inPlaceDead);
            }
            if (restoreDestMode(win) === 'inPlace' && inPlaceDead) {
                // No LUN on this node backs the chosen source — OR the shared
                // verdict refuses in place: the ONLY destination is a new
                // LUN. Re-default rather than leave a dead radio checked so
                // nothing reads a phantom `lun`.
                try { dest.setValue({ restoreDest: 'newLun' }); } catch (e2) { /* non-fatal */ }
            }
        }
        var ipNote = win.down('#restoreInPlaceNote');
        if (ipNote) {
            ipNote.update(refused ? enc(refused.reason) : '');
        }
        var path = win.down('#restoreTargetPath');
        if (path) {
            path.setValue(rl
                ? enc(rl.backingPath || '') + ' (' + enc(t('LUN')) + ' ' + enc(rl.index) + ')'
                : '');
        }
        var s = win.down('#newLunSource');
        if (s) {
            s.setValue(sourceLunPhrase(win, rl));
        }
        var ls = win.down('#lunSize');
        if (ls) {
            ls.setValue(rl
                ? enc(fmtBytes(rl.size)) + ' (' + enc('' + rl.size) + ' ' + enc(t('bytes')) + ')'
                : '<span style="color:gray;">&mdash;</span>');
        }
        setDestFieldVisibility(win, restoreDestMode(win) === 'newLun');
        applyNewLunKind(win);
        setRestoreNote(win, restoreDestMode(win) === 'newLun', rl ? rl.backingPath : '');
        // `updateRestoreSizes` computes the verdict AND the button's gate; a
        // second no-arg call here would disable it again (undefined ≠ true).
        updateRestoreSizes(win);
    }

    /** The "Source stays" phrase over the new-LUN form's source panel. */
    function sourceLunPhrase(win, rl) {
        var p = win._prefill && win._prefill.lun;
        if (rl) {
            return enc(rl.name || rl.index) + ' — ' + enc(rl.backingPath || '') + ' (' + enc(t('LUN')) + ' ' + enc(rl.index) + ')';
        }
        if (p && p.name) {
            return enc(p.name) + ' (' + enc(t('LUN')) + ' ' + enc(p.index) + ') — ' + enc(t('not on this node anymore'));
        }
        return enc(t('The source LUN is never touched.'));
    }

    /** Drop the new-LUN form's answers — a stale value must not ride a body. */
    function clearNewLunFields(win) {
        var set = function (sel, value) {
            var f = win.down(sel);
            if (!f) {
                return;
            }
            try {
                f.setValue(value);
            } catch (e) {
                // non-fatal
            }
        };
        set('#newLunTarget', '');
        set('#newLunName', '');
        set('#newLunPool', '');
        set('#filePicker', '');
        set('#imageSize', '<span style="color:gray;">&mdash;</span>');
        var verdict = win.down('#sizeVerdict');
        if (verdict) {
            verdict.update('');
        }
        var nv = win.down('#newLunVerdict');
        if (nv) {
            nv.update('');
        }
    }

    /** The safety property CHANGES with the destination; the note rebuilds. */
    function setRestoreNote(win, isNewLun, backing) {
        var note = win.down('#restoreNote');
        if (!note) {
            return;
        }
        if (!isNewLun) {
            note.update(enc(t('A block image is restored WHOLE — there is no "these files". '
                + 'The whole target goes offline for the duration (LIO\'s enable flag lives on '
                + 'the target portal group, not the LUN), every session drops and no initiator '
                + 'can log back in until it finishes. The image is streamed straight onto ')) + enc(backing)
                + enc(t('; the unit serial and the backstore attributes are untouched, so the '
                    + 'initiator sees the same disk with the backed-up contents.')));
        } else {
            note.update(enc(t('Restored as a NEW LUN: a fresh backing is created at exactly the image\'s '
                + 'size, the image is streamed into it, and the new LUN is mapped on the chosen target. '
                + 'The source LUN is never touched — it stays online, keeps its serial, and no initiator '
                + 'has to log out. The new LUN gets a FRESH unit serial: a restored copy is a NEW disk.')));
        }
    }

    /** The result panel: a finished new-LUN restore lands its identity here.
     * A poll budget that runs out hands back a STILL-RUNNING job — that must
     * never read as "finished": the daemon task owns the truth until it says
     * completed, and the new LUN may not exist yet. */
    function showNewLunResult(win, job) {
        var panel = win.down('#restoreResult');
        if (!panel) {
            return;
        }
        var nl = job && job.result && job.result.newLun;
        if (job && job.status !== 'completed') {
            panel.update('<span style="color:var(--anas-warn,#c9820b);">'
                + enc(t('The restore is still running — the daemon task is the truth. Watch the task; '
                    + 'the new LUN’s identity appears here if this dialog is still open when it finishes.'))
                + '</span>');
            return;
        }
        if (!nl) {
            panel.update('<span style="color:gray;font-size:0.9em;">'
                + enc(t('The restore job completed, but no new-LUN record came back with it — '
                    + 'check the task log for the LUN’s identity.')) + '</span>');
            return;
        }
        panel.update('<span style="color:var(--anas-good,#2e7d32);">'
            + enc(t('Restore complete — NEW LUN created')) + '</span>'
            + '<div style="font-family:monospace;margin:4px 0;">'
            + enc(nl.name) + ' — ' + enc(t('LUN')) + ' ' + enc(nl.index) + ' ' + enc(t('on'))
            + ' ' + enc(nl.targetIqn)
            + '<br>' + enc(t('serial')) + ' ' + enc(nl.serial)
            + '<br>' + enc(t('backed by')) + ' ' + enc(nl.backingPath)
            + '</div>'
            + '<span style="color:gray;font-size:0.9em;">'
            + enc(t('The source LUN was never touched.')) + '</span>');
    }

    /** The ANAS-owned targets for the new-LUN door, from the list read once. */
    function loadRestoreTargetChoices(win, node, preferIqn) {
        ANAS.api.get(node, '/iscsi/targets').then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            var targets = (res && res.data && isArray(res.data.targets)) ? res.data.targets : [];
            var rows = [];
            for (var i = 0; i < targets.length; i++) {
                var t = targets[i] || {};
                if (t.ownership !== 'anas') {
                    continue;
                }
                rows.push({ value: t.iqn, label: (t.name ? t.name + ' — ' : '') + t.iqn });
            }
            var combo = win.down('#newLunTarget');
            if (!combo) {
                return;
            }
            combo.getStore().loadData(rows);
            var pick = preferIqn || (rows.length ? rows[0].value : '');
            try {
                combo.setValue(pick || '');
            } catch (e) {
                // non-fatal
            }
            if (win._archiveKind === 'img') {
                updateRestoreSizes(win);
            }
        }, function () {
            // fail-open: the combo stays empty and the gate names the missing choice
        });
    }

    /**
     * The new-LUN backing pickers (#newLunPool / #filePicker) start EMPTY and
     * are filled only by ANAS.iscsi.loadBackingChoices (75-iscsi.js). The
     * new-LUN destination can appear on ANY door that reaches the image half,
     * so the read runs wherever loadRestoreTargetChoices does — the LUN door's
     * own up-front call included — guarded to run once per dialog.
     */
    function loadRestoreBackingChoices(win, node) {
        if (win._backingLoaded) {
            return;
        }
        win._backingLoaded = true;
        if (ANAS.iscsi && ANAS.iscsi.loadBackingChoices) {
            ANAS.iscsi.loadBackingChoices(node, win);
        }
    }

    /**
     * The button's gate — the ONLY part the image half hard-gates. A size
     * mismatch is silently destructive over a live block object, so Restore is
     * simply dead until this half says yes (the daemon refuses too). The files
     * half stays enabled: it owns the 409-confirm dance and validates on submit.
     */
    function updateSubmitGate(win, imageOk) {
        var submit;
        try {
            submit = win.down('#restoreSubmit');
        } catch (e) {
            return;
        }
        if (!submit) {
            return;
        }
        if (currentArchiveKind(win) !== 'img') {
            // The files half gates EXACTLY one thing: a `newLocation` restore
            // without its directory. The daemon may still ask its own
            // confirms (in-place tree, an existing chosen directory) — those
            // are the 409 dance, not a dead button.
            var ctx = restoreContext(win);
            submit.setDisabled(ctx.mode === 'newLocation' && !ctx.newPath);
            return;
        }
        submit.setDisabled(imageOk !== true);
    }

    /** Submit the IMAGE half. Same door, same shape as today. */
    function submitRestoreImage(win, node) {
        var rl = resolveThisLun(win);
        var snapshot = textOf(win, '#restoreSnapshot');
        var archive = textOf(win, '#restoreArchive');
        if (!snapshot || !archive) {
            ANAS.alertMsg('Incomplete', t('Choose a point in time and an image archive.'));
            return;
        }
        var size = selectedImageSize(win);
        var dest = restoreDestMode(win);
        if (dest === 'newLun') {
            var newLun = validateNewLun(win, size);
            if (!newLun.ok) {
                var nv = win.down('#newLunVerdict');
                if (nv) {
                    nv.update('<span style="color:var(--anas-bad,#c0392b);">' + enc(newLun.reason || newLun.prompt) + '</span>');
                }
                return;
            }
        } else {
            if (inPlaceRefused(win)) {
                // The shared verdict, re-checked where the button is dead:
                // the radio cannot be selected, but safety is not one check deep.
                ANAS.alertMsg('No destination', t('This LUN cannot take an in-place restore right now. '
                    + 'Restore it as a NEW LUN.'));
                return;
            }
            if (!rl) {
                ANAS.alertMsg('No destination', t('This image maps to no LUN on this node. Restore it as a NEW LUN.'));
                return;
            }
            if (size !== rl.size) {
                ANAS.alertMsg('Size mismatch', t('The image and the LUN are not the same size, so the restore is '
                    + 'refused. Restore this image onto a target of exactly its own size.'));
                return;
            }
        }

        var ctx = {
            repo: textOf(win, '#restoreRepo'),
            ns: textOf(win, '#restoreNs'),
            snapshot: snapshot,
            archive: archive,
            dest: dest,
            lun: (dest === 'inPlace' && rl) ? { targetIqn: rl.targetIqn, index: rl.index } : null,
            newLunTargetIqn: textOf(win, '#newLunTarget'),
            newLunName: textOf(win, '#newLunName'),
            newLunKind: newLunBackingKind(win),
            newLunPool: textOf(win, '#newLunPool'),
            filePath: textOf(win, '#filePicker'),
            fileSource: filePickerSource(win, textOf(win, '#filePicker')),
        };
        var body = imageRestoreBody(ctx);
        var sourceName = win._sourceName || '';
        var backing = rl ? rl.backingPath : '';

        var confirmTitle = dest === 'newLun' ? 'Restore as new LUN' : 'Restore LUN from backup';
        var confirmIntro = dest === 'newLun'
            ? enc(t('Restoring')) + ' ' + enc(archive) + ' ' + enc(t('from')) + ' ' + enc(snapshot)
                + ' ' + enc(t('as a NEW LUN')) + ' "' + enc(body.target.name) + '" ' + enc(t('on'))
                + ' ' + enc(body.target.targetIqn) + '. '
                + enc(t('The source LUN is untouched and stays online — there is no offline window and no '
                    + 'initiator has to log out. The new LUN gets a FRESH unit serial: a restored copy is '
                    + 'a NEW disk.'))
            : enc(t('Restoring')) + ' ' + enc(archive) + ' ' + enc(t('from')) + ' ' + enc(snapshot)
                + ' ' + enc(t('onto')) + ' ' + enc(backing || sourceName) + '.';

        ANAS.confirmAndRun({
            node: node,
            method: 'post',
            path: '/backup/restore',
            body: body,
            // The poll view is the LONG-LIVED component the dialog was opened
            // from (the same reference win._onDone belongs to) — the in-place
            // half closes `win` on acceptance, and a dead view would silence
            // the failure alert and the grids' refresh. The newLun half keeps
            // the dialog open, so its own result panel still reads `win` —
            // guarded, because the operator may close it while the job runs.
            view: win._view || win,
            // A whole-image restore re-reads every byte of the source and can
            // run for hours — the 15 s poll default would fire onComplete on
            // a still-running job. Same budget as the files half.
            maxMs: 3600000,
            confirmWindow: true,
            confirmTitle: confirmTitle,
            confirmIntro: confirmIntro,
            confirmButtonText: t('Restore'),
            failTitle: dest === 'newLun' ? 'Restore as new LUN failed' : 'Restore failed',
            successMsg: dest === 'newLun'
                ? t('Restored as a new LUN') + ': ' + archive
                : t('LUN restored') + ': ' + (sourceName || archive),
            onSubmitted: function () {
                if (dest === 'newLun') {
                    var note = win.down('#restoreNote');
                    if (note) {
                        note.update(enc(t('Restore accepted — a new LUN is being created. '
                            + 'Its identity appears here when it finishes.')));
                    }
                    return;
                }
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
            },
            onComplete: function (job) {
                if (dest === 'newLun' && !win.destroyed && !win.destroying) {
                    showNewLunResult(win, job);
                }
                if (win._onDone) {
                    win._onDone(job);
                }
            },
            onFailed: function (job) {
                if (dest === 'newLun' && !win.destroyed && !win.destroying) {
                    var msg = (job && job.error && job.error.message);
                    if (msg) {
                        var vr = win.down('#newLunVerdict');
                        if (vr) {
                            vr.update('<span style="color:var(--anas-bad,#c0392b);">' + enc(msg) + '</span>');
                        }
                    }
                }
                if (win._onDone) {
                    win._onDone(job);
                }
            }
        });
    }

    /**
     * The restore dialog — ONE dialog for every door. `prefill` is
     *   {}                      the task-less repository door (full source part),
     *   { task }                the task door — name or the task object,
     *   { lun: {targetIqn,index,serial,name}, … }  the LUN door — identity only;
     *     the dialog applies the shared in-place verdict (ANAS.iscsi.lunInPlace)
     *     to the LUN it resolves, for every door alike.
     * When task or lun is present the source part collapses to a summary line and
     * the dialog starts AT the point in time.
     */
    function openRestoreDialog(view, node, prefill) {
        var o = prefill || {};
        var win;
        var archiveStore;
        try {
            archiveStore = Ext.create('Ext.data.Store', {
                fields: ['archive', 'label'],
                data: [],
            });
        } catch (eStore) {
            ANAS.warn('restore dialog store failed: ' + ANAS.errText(eStore));
            return null;
        }

        // ---- the door's prefill, normalised ---------------------------------
        var taskObj = (o.task && typeof o.task === 'object') ? o.task : null;
        var taskName = taskObj ? ('' + (taskObj.name || '')) : ('' + (o.task || '')).trim();
        var lunPre = o.lun || null;
        var sourceCollapsed = !!(taskName || lunPre);
        var repo = trim(o.repo) || (taskObj ? repoNameOf(taskObj) : '');
        var ns = '' + (first(trim(o.ns), taskObj && taskObj.namespace) || '');
        var sourceGroup = trim(o.group) || (taskObj && backupIdOf(taskObj) ? 'host/' + backupIdOf(taskObj) : '');
        var homeByArchive = (o.homeByArchive && Object.keys(o.homeByArchive).length)
            ? o.homeByArchive
            : null; // derived from the task object when a real one is known

        // ---- the what/where part's anchor points ----------------------------
        var taskLun = null;
        var taskLunSerial = '';
        if (taskObj) {
            var archList = archivesOf(taskObj);
            for (var ai = 0; ai < archList.length; ai++) {
                var r0 = archList[ai] || {};
                if (archiveKindOf(r0) === 'img') {
                    taskLun = lunRefOf(r0) || taskLun;
                }
            }
            var bid = backupIdOf(taskObj);
            var mB = /^lun-(.+)$/.exec(bid);
            if (mB) {
                taskLunSerial = mB[1];
            }
        }

        var items = [];

        // ---- the source part ------------------------------------------------

        // On a pre-filled door ONE read-only summary line replaces the fields;
        // a "change source…" link expands them (collapsed by default).
        if (sourceCollapsed) {
            items.push({
                xtype: 'component',
                itemId: 'restoreSourceSummary',
                cls: 'anas-restore-source-summary',
                padding: '0 0 8 0',
                html: '',
            });
            items.push({
                xtype: 'button',
                itemId: 'restoreChangeSource',
                cls: 'anas-btn-restore-change-source',
                text: t('Change source…'),
                scale: 'small',
                margin: '0 0 6 0',
                handler: function () {
                    win._sourceExpanded = true;
                    applyRestoreSourceVisibility(win);
                    loadRestoreGroups(win, node);
                },
            });
        }

        // The fields themselves: hidden + disabled on a collapsed pre-filled
        // door, the whole editable source part on the task-less door.
        items.push({
            xtype: 'fieldset',
            itemId: 'restoreSourceFields',
            cls: 'anas-restore-source-fields',
            title: t('Source'),
            defaults: { anchor: '100%' },
            items: [
                {
                    xtype: 'combobox',
                    itemId: 'restoreRepo',
                    cls: 'anas-fld-restore-repo',
                    fieldLabel: t('Repository'),
                    store: Ext.create('Ext.data.Store', { fields: ['name', 'label', 'namespace'], data: [] }),
                    displayField: 'label',
                    valueField: 'name',
                    queryMode: 'local',
                    editable: true,
                    value: repo,
                    listeners: {
                        change: function () {
                            win._group = '';
                            win._groupKnown = false;
                            loadRestoreGroups(win, node);
                            updateRestoreSummary(win);
                            if (win._archiveKind === 'img') { resolveAndRefreshImage(win); }
                        },
                    },
                },
                {
                    xtype: 'textfield',
                    itemId: 'restoreNs',
                    cls: 'anas-fld-restore-ns',
                    fieldLabel: t('Namespace'),
                    emptyText: t('the repository\u2019s own'),
                    value: ns,
                    listeners: {
                        change: function () {
                            win._group = '';
                            win._groupKnown = false;
                            loadRestoreGroups(win, node);
                            updateRestoreSummary(win);
                            if (win._archiveKind === 'img') { resolveAndRefreshImage(win); }
                        },
                    },
                },
                {
                    // A combo, not a plain field: the groups in a namespace are
                    // one read away and nobody remembers a backup-id. Typing
                    // still works — the repository door exists precisely because
                    // the task that would have known the name is gone.
                    xtype: 'combobox',
                    itemId: 'restoreGroup',
                    cls: 'anas-fld-restore-group',
                    fieldLabel: t('Backup group'),
                    emptyText: 'host/<backup-id>',
                    store: Ext.create('Ext.data.Store', { fields: ['group', 'label'], data: [] }),
                    displayField: 'label',
                    valueField: 'group',
                    queryMode: 'local',
                    editable: true,
                    value: sourceGroup,
                    listeners: {
                        change: function () {
                            win._group = trim(valOf(win, '#restoreGroup'));
                            win._groupKnown = !!win._group;
                            updateRestoreSummary(win);
                            if (win._archiveKind === 'img') { resolveAndRefreshImage(win); }
                        },
                    },
                },
            ],
        });

        // ---- point in time, then the archive (which kind picks the part) ----
        items.push({
            xtype: 'fieldcontainer',
            layout: 'hbox',
            items: [
                {
                    xtype: 'textfield',
                    itemId: 'restoreSnapshot',
                    cls: 'anas-fld-restore-snapshot',
                    fieldLabel: t('Point in time'),
                    labelWidth: 130,
                    flex: 1,
                    // The full composed id is the value and is never truncated:
                    // a bare group path would silently restore the LATEST.
                    emptyText: 'host/<id>/<RFC3339>',
                },
                {
                    xtype: 'button',
                    itemId: 'restoreSnapPick',
                    cls: 'anas-btn-restore-snap',
                    text: t('Choose…'),
                    margin: '0 0 0 6',
                    handler: function () { pickRestoreSnapshot(win, node); },
                },
            ],
        });
        items.push({
            xtype: 'combobox',
            itemId: 'restoreArchive',
            cls: 'anas-fld-restore-archive',
            fieldLabel: t('Archive'),
            store: archiveStore,
            displayField: 'label',
            valueField: 'archive',
            queryMode: 'local',
            editable: false,
            listeners: {
                change: function () { restoreArchiveChanged(win, node); },
            },
        });
        items.push({ xtype: 'component', itemId: 'restoreArchiveNote', padding: '0 0 6 130', html: '' });

        // ---- what/where: the FILES half (archive kind pxar) -----------------
        items.push({
            xtype: 'fieldcontainer',
            itemId: 'restoreFilesWrap',
            cls: 'anas-restore-files-part',
            fieldLabel: t('Restore files'),
            labelWidth: 130,
            hidden: true,
            disabled: true,
            layout: 'anchor',
            defaults: { anchor: '100%', labelWidth: 130 },
            items: [
                {
                    xtype: 'fieldcontainer',
                    fieldLabel: t('Restore'),
                    labelWidth: 130,
                    layout: 'hbox',
                    items: [
                        {
                            xtype: 'component',
                            itemId: 'restoreSelectionList',
                            flex: 1,
                            html: mutedSpan(t('Nothing picked yet.')),
                        },
                        {
                            xtype: 'button',
                            itemId: 'restoreFilesPick',
                            cls: 'anas-btn-restore-files',
                            text: t('Choose files…'),
                            margin: '0 0 0 6',
                            handler: function () { pickRestoreFiles(win, node); },
                        },
                    ],
                },
                {
                    xtype: 'textfield',
                    itemId: 'restoreHome',
                    cls: 'anas-fld-restore-home',
                    fieldLabel: t('Source directory'),
                    emptyText: '/srv/data',
                    value: '',
                    listeners: { change: function () { refreshRestore(win); } },
                },
                // backup2.10 — the TWO-way destination choice (ruling
                // 2026-08-29: the beside-the-original mode is dropped — no
                // established backup tool has one). Into the original keeps
                // its merge/gate semantics; somewhere else names a directory
                // that is created if new, or merged into after the daemon's
                // confirm if it exists. Somewhere-else is the default and its
                // path is REQUIRED — Restore stays dead until it is typed.
                {
                    xtype: 'radiogroup',
                    itemId: 'restoreTargetKind',
                    cls: 'anas-fld-restore-target-kind',
                    fieldLabel: t('Restore to'),
                    labelWidth: 130,
                    columns: 1,
                    vertical: true,
                    items: [
                        { boxLabel: t('Into the original \u2014 overwrite matching files, keep the rest'), name: 'restoreTarget', inputValue: 'inPlace' },
                        { boxLabel: t('Somewhere else\u2026'), name: 'restoreTarget', inputValue: 'newLocation', checked: true },
                    ],
                    listeners: {
                        change: function (grp) {
                            try {
                                var win = grp.up('window');
                                refreshRestore(win);
                                updateSubmitGate(win);
                            } catch (e) {
                                // non-fatal
                            }
                        }
                    }
                },
                {
                    xtype: 'fieldcontainer',
                    itemId: 'restoreNewLocationWrap',
                    fieldLabel: t('Destination directory'),
                    labelWidth: 130,
                    hidden: true,
                    disabled: true,
                    layout: 'hbox',
                    items: [
                        {
                            xtype: 'textfield',
                            itemId: 'restoreNewLocation',
                            cls: 'anas-fld-restore-new-location',
                            flex: 1,
                            emptyText: t('/srv/restores/pictures-2026-08-25'),
                            listeners: {
                                change: function () {
                                    refreshRestore(win);
                                    updateSubmitGate(win);
                                }
                            },
                        },
                        {
                            xtype: 'button',
                            itemId: 'restoreNewLocationBrowse',
                            cls: 'anas-btn-restore-new-location-browse',
                            text: t('Browse\u2026'),
                            margin: '0 0 0 6',
                            handler: function () { pickNewRestoreLocation(win, node); },
                        },
                    ],
                },
                {
                    xtype: 'component',
                    itemId: 'restoreNewLocationNote',
                    padding: '2 0 0 130',
                    html: mutedSpan(t('Created by this restore if it does not exist. If it already exists, ANAS '
                        + 'will ask you to confirm and then merge into it: files with the same names are '
                        + 'replaced, everything else is kept.')),
                },
                {
                    xtype: 'fieldcontainer',
                    fieldLabel: t('Target'),
                    labelWidth: 130,
                    items: [{ xtype: 'component', itemId: 'restoreTargetNote', html: '' }],
                },
                {
                    xtype: 'fieldset',
                    title: t('Ownership, ACLs and permissions'),
                    collapsible: true,
                    collapsed: true,
                    padding: '6 10 8',
                    defaults: { anchor: '100%' },
                    items: [
                        {
                            xtype: 'checkbox',
                            itemId: 'restoreIgnoreOwnership',
                            cls: 'anas-chk-restore-ignore-ownership',
                            fieldLabel: t('Ignore ownership'),
                            boxLabel: t('everything lands owned by root; an existing file keeps its current owner'),
                        },
                        {
                            xtype: 'checkbox',
                            itemId: 'restoreIgnoreAcls',
                            cls: 'anas-chk-restore-ignore-acls',
                            fieldLabel: t('Ignore ACLs'),
                            boxLabel: t('named ACL entries are dropped; the file mode is still applied'),
                        },
                        {
                            xtype: 'checkbox',
                            itemId: 'restoreIgnoreXattrs',
                            cls: 'anas-chk-restore-ignore-xattrs',
                            fieldLabel: t('Ignore xattrs'),
                            boxLabel: t('extended attributes are dropped; POSIX ACLs are not affected'),
                        },
                        {
                            xtype: 'checkbox',
                            itemId: 'restoreIgnorePermissions',
                            cls: 'anas-chk-restore-ignore-permissions',
                            fieldLabel: t('Ignore permissions'),
                            boxLabel: t('newly created files land as 0600 \u2014 not their archived mode, and not your umask'),
                        },
                    ],
                },
                {
                    xtype: 'fieldcontainer',
                    fieldLabel: t('Estimated size'),
                    labelWidth: 130,
                    items: [{ xtype: 'component', itemId: 'restoreEstimate', html: '' }],
                },
                {
                    xtype: 'textfield',
                    itemId: 'restoreRate',
                    cls: 'anas-fld-restore-rate',
                    fieldLabel: t('Rate limit'),
                    emptyText: t('unlimited (e.g. 50MB)'),
                },
            ],
        });

        // ---- what/where: the IMAGE half (archive kind img) ------------------
        items.push({
            xtype: 'fieldcontainer',
            itemId: 'restoreImageWrap',
            cls: 'anas-restore-image-part',
            fieldLabel: t('Restore image'),
            labelWidth: 130,
            hidden: true,
            disabled: true,
            layout: 'anchor',
            defaults: { anchor: '100%', labelWidth: 190 },
            items: [
                {
                    // backup2.10 — the TWO doors. In place is the whole-image
                    // restore (the target's TPG goes offline for the run, the
                    // image must be EXACTLY this LUN's size). A NEW LUN creates
                    // the backing at the image's own size on a target of the
                    // operator's choosing; the source LUN is never touched.
                    xtype: 'radiogroup',
                    itemId: 'restoreDest',
                    cls: 'anas-fld-restore-dest',
                    fieldLabel: t('Restore to'),
                    columns: 1,
                    vertical: true,
                    items: [
                        { boxLabel: t('This LUN (in place)'), name: 'restoreDest', inputValue: 'inPlace', checked: true },
                        { boxLabel: t('A new LUN\u2026'), name: 'restoreDest', inputValue: 'newLun' }
                    ],
                    listeners: {
                        change: function (grp) {
                            var w2 = grp.up('window');
                            setDestFieldVisibility(w2, restoreDestMode(w2) === 'newLun');
                            applyNewLunKind(w2);
                            setRestoreNote(w2, restoreDestMode(w2) === 'newLun',
                                resolveThisLun(w2) ? resolveThisLun(w2).backingPath : '');
                            updateRestoreSizes(w2);
                        }
                    }
                },
                {
                    // The in-place refusal, when the dialog's shared verdict
                    // (ANAS.iscsi.lunInPlace — one helper, every door) says the
                    // LUN cannot take the overwrite: the radio is disabled
                    // through the SAME stray-mapping machinery and this muted
                    // line carries the reason. Empty unless refused.
                    xtype: 'component',
                    itemId: 'restoreInPlaceNote',
                    cls: 'anas-restore-inplace-note',
                    padding: '2 0 0 190',
                    style: 'color:gray;font-size:11px;',
                    html: ''
                },
                {
                    xtype: 'displayfield',
                    itemId: 'restoreTargetPath',
                    cls: 'anas-restore-target-path',
                    fieldLabel: t('Restoring onto'),
                    value: ''
                },
                {
                    xtype: 'fieldset',
                    itemId: 'newLunFields',
                    cls: 'anas-fld-restore-newlun',
                    title: t('New LUN'),
                    hidden: true,
                    disabled: true,
                    defaults: { anchor: '100%' },
                    items: [
                        {
                            xtype: 'displayfield',
                            itemId: 'newLunSource',
                            fieldLabel: t('Source stays'),
                            value: ''
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'newLunTarget',
                            cls: 'anas-fld-restore-newlun-target',
                            fieldLabel: t('On target'),
                            store: Ext.create('Ext.data.Store', { fields: ['value', 'label'], data: [] }),
                            valueField: 'value',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            emptyText: t('(loading\u2026)'),
                            listeners: {
                                change: function (c) { updateRestoreSizes(c.up('window')); }
                            }
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'newLunName',
                            cls: 'anas-fld-restore-newlun-name',
                            fieldLabel: t('LUN name'),
                            allowBlank: false,
                            emptyText: 'vmdisk1',
                            listeners: {
                                change: function (c) { updateRestoreSizes(c.up('window')); }
                            }
                        },
                        {
                            xtype: 'radiogroup',
                            itemId: 'newLunKind',
                            cls: 'anas-fld-restore-newlun-kind',
                            fieldLabel: t('Backed by'),
                            columns: 1,
                            vertical: true,
                            items: [
                                { boxLabel: t('A new ZFS volume (zvol) on a ZFS pool'), name: 'lunKind', inputValue: 'zvol', checked: true },
                                { boxLabel: t('A new raw image file on a dataset or AHR pool'), name: 'lunKind', inputValue: 'file' }
                            ],
                            listeners: {
                                change: function (grp) {
                                    var w2 = grp.up('window');
                                    applyNewLunKind(w2);
                                    updateRestoreSizes(w2);
                                }
                            }
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'newLunPool',
                            cls: 'anas-fld-restore-newlun-pool',
                            fieldLabel: t('ZFS pool'),
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            displayField: 'label',
                            valueField: 'name',
                            store: Ext.create('Ext.data.Store', { fields: ['name', 'label'], data: [] }),
                            emptyText: t('(the ZFS pool the volume is created on)'),
                            listeners: {
                                change: function (c) { updateRestoreSizes(c.up('window')); }
                            }
                        },
                        {
                            // The SAME dataset/AHR picker the add-LUN door uses;
                            // a row's `source` flag keeps the backing phrase
                            // (`dataset` vs `ahrPool`) honest.
                            xtype: 'combobox',
                            itemId: 'filePicker',
                            cls: 'anas-fld-lun-dataset',
                            fieldLabel: t('Dataset or AHR pool'),
                            hidden: true,
                            disabled: true,
                            queryMode: 'local',
                            displayField: 'label',
                            valueField: 'name',
                            store: Ext.create('Ext.data.Store', { fields: ['name', 'label', 'source'], data: [] }),
                            emptyText: t('pool/dataset'),
                            listeners: {
                                change: function (c) { updateRestoreSizes(c.up('window')); }
                            }
                        }
                    ]
                },
                {
                    xtype: 'fieldcontainer',
                    itemId: 'newLunVerdictWrap',
                    hidden: true,
                    disabled: true,
                    fieldLabel: '',
                    items: [{ xtype: 'component', itemId: 'newLunVerdict', cls: 'anas-restore-newlun-verdict', html: '' }],
                },
                {
                    xtype: 'fieldcontainer',
                    itemId: 'lunSizeWrap',
                    fieldLabel: t('LUN size'),
                    items: [{ xtype: 'displayfield', itemId: 'lunSize', cls: 'anas-fld-restore-lun-size', value: '' }],
                },
                {
                    xtype: 'displayfield',
                    itemId: 'imageSize',
                    cls: 'anas-fld-restore-image-size',
                    fieldLabel: t('Image size'),
                    value: '<span style="color:gray;">&mdash;</span>'
                },
                {
                    xtype: 'fieldcontainer',
                    itemId: 'sizeVerdictWrap',
                    fieldLabel: '',
                    items: [{ xtype: 'component', itemId: 'sizeVerdict', cls: 'anas-restore-size-verdict', html: '' }],
                },
                {
                    xtype: 'component',
                    itemId: 'restoreNote',
                    margin: '4 0 0 0',
                    style: 'color:gray;font-size:11px;',
                    html: ''
                },
                {
                    // backup2.10 — the RESULT PANEL: a newLun restore keeps the
                    // dialog open and lands the new LUN's identity here.
                    xtype: 'component',
                    itemId: 'restoreResult',
                    cls: 'anas-restore-result',
                    margin: '8 0 0 0',
                    html: ''
                }
            ],
        });

        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-backup-restore',
                title: t('Restore'),
                modal: true,
                width: 720,
                autoScroll: true,
                bodyPadding: 12,
                layout: 'anchor',
                defaults: { anchor: '100%', labelWidth: 130 },
                items: items,
                buttons: [
                    { text: t('Cancel'), handler: function () { win.close(); } },
                    {
                        text: t('Restore\u2026'),
                        itemId: 'restoreSubmit',
                        cls: 'anas-btn-restore-submit',
                        handler: function () { submitRestore(win, node); },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('restore dialog failed: ' + ANAS.errText(e));
            return null;
        }

        win._task = taskName;
        win._taskObj = taskObj;
        win._repo = repo;
        win._ns = ns;
        win._homeByArchive = homeByArchive || {};
        win._selections = [];
        win._selectionRows = [];
        win._archives = [];
        win._group = sourceGroup;
        win._groupKnown = !!(sourceGroup || o.group);
        win._sourceCollapsed = sourceCollapsed;
        win._sourceExpanded = false;
        win._prefill = o;
        win._prefillLun = lunPre;
        win._view = view;
        win._node = node;
        win._onDone = (typeof o.onDone === 'function') ? o.onDone : null;
        win._taskLun = taskLun;
        win._taskLunSerial = taskLunSerial;
        win._sourceName = lunPre && lunPre.name
            ? ('' + lunPre.name)
            : (taskObj ? ('' + (taskObj.name || '')) : '');
        win._lunInventory = [];
        win._lunReceived = false;
        win._archiveKind = '';

        if (taskObj) {
            buildTaskDerived(win, taskObj);
        } else if (taskName) {
            fetchRestoreTask(win, node, taskName);
        }
        if (lunPre) {
            loadRestoreRepos(win, node);
        } else if (!sourceCollapsed) {
            loadRestoreRepos(win, node);
        }
        if (lunPre || taskLun || taskLunSerial) {
            ensureLunInventory(win, node);
            // The new-LUN destination can appear on ANY door that may reach the
            // image half, so the ANAS-owned target combo is filled up front
            // (defaulting to the LUN door's own target when there is one) —
            // and the backing pickers load right beside it, once per dialog
            // (the repository door loads them at image-half entry instead).
            loadRestoreTargetChoices(win, node, lunPre ? lunPre.targetIqn : '');
            loadRestoreBackingChoices(win, node);
        }

        win.show();
        applyRestoreSourceVisibility(win);
        setRestorePartVisibility(win);
        if (lunPre) {
            resolveAndRefreshImage(win);
        }
        refreshRestore(win);
        updateRestoreSummary(win);
        updateSubmitGate(win);
        return win;
    }

    /** The task-bound restore door's prefill, fed through the ONE dialog. */
    function openRestoreFromDetail(win, node, name) {
        var detail = win._detail || {};
        var task = detail.task || detail || {};
        var homeByArchive = {};
        var list = archivesOf(task);
        for (var i = 0; i < list.length; i++) {
            var a = list[i] || {};
            if (a.name && a.path && archiveKindOf(a) !== 'img') {
                homeByArchive[bareArchive(a.name)] = a.path;
            }
        }
        // The poll view is the backup grid behind this detail window when it is
        // known — the dialog must keep polling after this window closes.
        openRestoreDialog(win._view || win, node, {
            task: task,
            homeByArchive: homeByArchive,
        });
    }

    /** Derive the collapsed-task-door context from the task object. */
    function buildTaskDerived(win, task) {
        if (!task) {
            return;
        }
        var list = archivesOf(task);
        if (!Object.keys(win._homeByArchive).length) {
            var homes = {};
            for (var i = 0; i < list.length; i++) {
                var a = list[i] || {};
                if (a.name && a.path && archiveKindOf(a) !== 'img') {
                    homes[bareArchive(a.name)] = a.path;
                }
            }
            win._homeByArchive = homes;
        }
        if (!win._groupKnown) {
            var bid = backupIdOf(task);
            if (bid) {
                win._group = 'host/' + bid;
            }
        }
    }

    /** A bare task NAME needs its object: repo/ns/group/homes all come from it. */
    function fetchRestoreTask(win, node, name) {
        ANAS.api.get(node, '/backup/tasks/' + encodeURIComponent(name)).then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            var d = (res && res.data) || {};
            var task = d.task || d || {};
            win._taskObj = task;
            buildTaskDerived(win, task);
            if (!trim(valOf(win, '#restoreRepo'))) {
                try { win.down('#restoreRepo').setValue(repoNameOf(task)); } catch (e) { /* non-fatal */ }
            }
            if (!trim(valOf(win, '#restoreNs'))) {
                try { win.down('#restoreNs').setValue(first(task.namespace) || ''); } catch (e2) { /* non-fatal */ }
            }
            try { win.down('#restoreGroup').setValue(win._group); } catch (e3) { /* non-fatal */ }
            updateRestoreSummary(win);
            refreshRestore(win);
        }, function (err) {
            ANAS.warn('restore task load failed: ' + ANAS.errText(err));
            updateRestoreSummary(win);
        });
    }

    /** Show the source as fields (task-less, or expanded) or as the summary. */
    function applyRestoreSourceVisibility(win) {
        var visible = !win._sourceCollapsed || win._sourceExpanded === true;
        var set = function (sel) {
            var f = win.down(sel);
            if (!f) {
                return;
            }
            f.setHidden(!visible);
            f.setDisabled(!visible);
        };
        set('#restoreRepo');
        set('#restoreNs');
        set('#restoreGroup');
        var wrap = win.down('#restoreSourceFields');
        if (wrap) {
            wrap.setHidden(!visible);
        }
        var sum = win.down('#restoreSourceSummary');
        if (sum) {
            // The summary shows while the door is collapsed; "change source…"
            // hides it as it expands the editable fields.
            sum.setHidden(!!(win._sourceCollapsed && win._sourceExpanded === true));
        }
    }

    /** The one read-only source line of a pre-filled door. */
    function updateRestoreSummary(win) {
        var sum = win.down('#restoreSourceSummary');
        if (!sum) {
            return;
        }
        var p = win._prefill;
        var html;
        if (p && p.lun) {
            var name = p.lun.name || '';
            var grp = win._group || (p.lun.serial ? 'lun-' + p.lun.serial : '');
            var repo1 = trim(valOf(win, '#restoreRepo')) || '';
            html = enc(t('From LUN')) + ' <b>' + enc(name) + '</b> \u2014 '
                + enc(t('group')) + ' <b>' + enc(grp) + '</b> '
                + enc(t('in')) + ' <b>' + enc(repo1) + '</b>';
        } else {
            var parts = [];
            var r = trim(valOf(win, '#restoreRepo')) || '';
            var n = trim(valOf(win, '#restoreNs')) || '';
            var g = win._group || '';
            if (r) { parts.push('<b>' + enc(r) + '</b>'); }
            if (n) { parts.push('<b>' + enc(n) + '</b>'); }
            if (g) { parts.push('<b>' + enc(g) + '</b>'); }
            html = enc(t('From task')) + ' <b>' + enc(win._task) + '</b>'
                + (parts.length ? (' \u2014 ' + parts.join(' / ')) : '');
        }
        sum.update(html);
    }



    /**
     * Fill the group combo from the chosen repository + namespace. One read,
     * on a change the operator made — never a poll.
     *
     * On the LUN door, the group is not a free choice either: a block task's
     * backup-id is `lun-<unit serial>`, so its group (`host/lun-<serial>`, say)
     * IS this LUN's backup. When that group exists it is pre-selected; only
     * when it does not (the LUN was never backed up, or was backed up before
     * its backup-id derived from the serial) are the repository's other groups
     * offered.
     */
    function loadRestoreGroups(win, node) {
        var repo = trim(valOf(win, '#restoreRepo'));
        var combo = win.down('#restoreGroup');
        if (!repo || !combo) {
            return;
        }
        var ns = trim(valOf(win, '#restoreNs'));
        var url = '/backup/repos/' + encodeURIComponent(repo) + '/groups'
            + (ns ? ('?ns=' + encodeURIComponent(ns)) : '');
        return ANAS.api.get(node, url).then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            var d = (res && res.data) || {};
            if (d.verdict && d.verdict !== 'ok') {
                restoreNote(win, 'restoreArchiveNote',
                    '<span style="color:var(--anas-warn,#b06a12);">'
                    + enc(d.detail || t('The backup server could not be read.')) + '</span>');
                return;
            }
            var groups = isArray(d.groups) ? d.groups : [];
            var autoId = (win._prefillLun && win._prefillLun.serial)
                ? ('lun-' + win._prefillLun.serial)
                : '';
            var found = '';
            var data = [];
            for (var i = 0; i < groups.length; i++) {
                var g = groups[i] || {};
                if (!g.group) {
                    continue;
                }
                data.push({
                    group: g.group,
                    label: g.group + (g.lastBackupIso ? ('  —  ' + t('last') + ' ' + g.lastBackupIso) : ''),
                });
                // The PBS group reports its backup-id as the id segment; a block
                // LUN's group is `<backup-type>/lun-<serial>`.
                if (autoId && g.backupId === autoId) {
                    found = g.group;
                }
            }
            try {
                combo.getStore().loadData(data);
            } catch (e) {
                // non-fatal
            }
            if (found && !win._groupKnown) {
                try {
                    combo.setValue(found);
                } catch (e2) {
                    // non-fatal
                }
                win._group = found;
                win._groupKnown = true;
                updateRestoreSummary(win);
                if (win._archiveKind === 'img') {
                    resolveAndRefreshImage(win);
                }
            } else if (!win._groupKnown) {
                win._group = '';
            }
            if (autoId && !found) {
                restoreNote(win, 'restoreArchiveNote',
                    '<span style="color:var(--anas-muted,gray);font-size:0.9em;">'
                    + enc(t('No group named') + ' ' + autoId + ' — '
                        + t('the repository’s other groups are offered instead.')) + '</span>');
            }
        }, function (err) {
            ANAS.warn('restore group list failed: ' + ANAS.errText(err));
        });
    }

    /**
     * Fill the repository combo for the task-less door.
     *
     * Through `loadRepoOptions` — the ONE repository-list builder in this file,
     * PVE badge and all. A second loop here would drift from the wizard's list
     * the first time the badge rule changed.
     */
    function loadRestoreRepos(win, node) {
        return loadRepoOptions(node).then(function (opts) {
            if (win.destroyed || win.destroying) {
                return;
            }
            try {
                var combo = win.down('#restoreRepo');
                combo.getStore().loadData(opts);
                // Default to the first repository when nothing is chosen yet —
                // most nodes have one, and an empty combo cannot list groups.
                // It stays a choice: changing it reloads the groups.
                // Zero re-entry: a repository that records its own namespace
                // pre-fills it (the way the task path does).
                if (opts.length) {
                    if (!trim(combo.getValue())) {
                        combo.setValue(opts[0].name);
                    }
                    var chosen = null;
                    try {
                        // exactMatch — the in-repo form: ExtJS's default is a
                        // case-insensitive PREFIX match, so 'pbs' would
                        // resolve to 'pbs-offsite' (whichever sorts first)
                        // and prefill the WRONG repo's namespace.
                        var rec0 = combo.getStore() && combo.getStore().findRecord
                            ? combo.getStore().findRecord('name', combo.getValue(), 0, false, true, true)
                            : null;
                        chosen = rec0 ? rec0.get('namespace') : '';
                    } catch (e) {
                        chosen = null;
                    }
                    if (chosen === undefined || chosen === null) {
                        chosen = '';
                    }
                    if (!trim(valOf(win, '#restoreNs'))) {
                        try {
                            win.down('#restoreNs').setValue('' + chosen);
                        } catch (e2) {
                            // non-fatal
                        }
                    }
                }
            } catch (e) {
                ANAS.warn('restore repo combo failed: ' + ANAS.errText(e));
            }
            loadRestoreGroups(win, node);
        }, function (err) {
            ANAS.warn('restore repo list failed: ' + ANAS.errText(err));
        });
    }

    // The pure parts, exported so the dialog-contract harness can drive them
    // without an ExtJS window — the same seam the picker uses.
    ANAS.backupRestore = {
        restoreBody: restoreBody,
        imageRestoreBody: imageRestoreBody,
        restoreContext: restoreContext,
        restorableArchives: restorableArchives,
        imageArchivesOf: imageArchivesOf,
        lunSerialOfGroup: lunSerialOfGroup,
        archiveBytes: archiveBytes,
        hasDirectorySelection: hasDirectorySelection,
        needsConfirm: needsConfirm,
        open: openRestoreDialog,
    };

    // The second doors reach in here: the iSCSI LUN toolbar (75-iscsi.js) opens
    // the SAME restore dialog with a `{lun}` prefill — never a second dialog.
    ANAS.backup.openRestoreDialog = function (view, node, prefill) {
        return openRestoreDialog(view, node, prefill);
    };

    // ---- View registration -------------------------------------------------

    ANAS.views['backup'] = {
        itemId: 'anas-backup',
        text: t('Backup'),
        iconCls: 'fa fa-archive',
        factory: function (node) {
            try {
                return backupView(node);
            } catch (e) {
                ANAS.warn('backup view failed: ' + ANAS.errText(e));
                return ANAS.errorPanel(ANAS.errText(e));
            }
        },
    };
})();
