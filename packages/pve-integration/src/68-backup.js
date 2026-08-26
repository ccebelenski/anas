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
 *     { task, lastRunResult, lastRunAt, nextRunAt, overdue }
 *     task = { name, repository (repo NAME; alias `repo`), datastore? (else joined
 *              from the repos list), namespace?, backupId (alias `backup-id`/
 *              `backupID`), archives:[{name, path, excludes:[],
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
 *     lastRunResult ('success'|'failure'|'running'|'skipped'|'unknown' — 'skipped'
 *     is a biweekly off-week fire: it ran and deliberately did nothing, which is
 *     neither a success nor a failure), lastRunAt (ISO),
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
 *     TaskWrite = { name, repository, namespace?, backupId, archives, mode
 *       (=changeDetectionMode), retention?, notify, enabled, and EITHER `cadence`
 *       (structured — the daemon derives the OnCalendar; this view never
 *       generates one) OR `schedule` (the raw expression, for the Custom kind)}.
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
 *   Path-picker candidates (convenience, best-effort — free-typing always works):
 *     GET /v1/mounts (mountpoints) + GET /v1/pools then
 *     GET /v1/pools/:name/datasets (dataset mountpoints).
 * ---------------------------------------------------------------------------
 *
 * Test hooks: view 'anas-view anas-view-backup'; grid 'anas-grid-backup'; toolbar
 * 'anas-btn-backup-refresh' / '-new' / '-repos' / '-run' / '-edit' / '-toggle' /
 * '-delete' / '-details'; detail window 'anas-win-backup-detail' (body
 * 'anas-backup-detail', reload 'anas-btn-backup-detail-reload'); task window
 * 'anas-win-backup-task' (submit 'anas-btn-backup-task-submit', archives
 * 'anas-backup-archives', per-row path browse 'anas-btn-backup-arch-browse',
 * per-row nested choice 'anas-fld-backup-arch-nested' with its path list
 * 'anas-fld-backup-arch-nested-paths' and inline alert
 * 'anas-backup-arch-nested-alert',
 * schedule fieldset 'anas-backup-schedule' with 'anas-fld-backup-cadence' /
 * '-day' / '-single-day' / '-parity' / '-time' / '-schedule');
 * retention fieldset 'anas-backup-retention' with 'anas-fld-backup-keeplast' …
 * 'anas-fld-backup-keepyearly', preview 'anas-btn-backup-retention-preview'
 * rendering into 'anas-backup-retention-preview');
 * notification mode combo 'anas-fld-backup-notify';
 * directory picker 'anas-win-fs-picker' (grid 'anas-grid-fs-picker', path field
 * 'anas-fld-fs-path', select 'anas-btn-fs-select'); repos manager
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

    // A task's archive names carry an implied `.pxar`; the wizard shows the bare
    // name. Strip a trailing `.pxar` a user typed so we never double it.
    function bareArchive(name) {
        return trim(name).replace(/\.pxar$/i, '');
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
            out.push(row);
        }
        return out;
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
                opts.push({ name: r.name, label: label });
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
    //  Directory picker — 'anas-win-fs-picker' (driven by GET /v1/fs/browse)
    //
    //  A small, plain listbox-style navigator (no tree widget): the current
    //  path (editable + Go), an Up button, a list of child dirs (double-click
    //  descends), and Select to return the current path. Fail-open: an
    //  unreadable / non-directory path silently falls back to '/'. Free-form
    //  typing in the wizard field is untouched — this only fills it.
    // ======================================================================

    // Join a directory and a child name into an absolute path.
    function joinDir(base, name) {
        var b = trim(base) || '/';
        if (b.charAt(b.length - 1) === '/') {
            return b + name;
        }
        return b + '/' + name;
    }

    // Parent of an absolute path ('/' is its own parent).
    function parentDir(p) {
        var s = trim(p);
        if (!s || s === '/') {
            return '/';
        }
        // Drop a trailing slash, then the last segment.
        s = s.replace(/\/+$/, '');
        var idx = s.lastIndexOf('/');
        if (idx <= 0) {
            return '/';
        }
        return s.substring(0, idx);
    }

    function setPickerNote(win, msg, warn) {
        var c = win.down('#pickerNote');
        if (!c) {
            return;
        }
        var color = warn ? 'var(--anas-warn,#b06a12)' : 'var(--anas-muted,gray)';
        try {
            c.update(msg
                ? '<span style="color:' + color + ';font-size:12px;">' + enc(msg) + '</span>'
                : '');
        } catch (e) {
            // non-fatal
        }
    }

    // Browse to a path: list its child dirs, or fall back to '/' when it is not
    // a readable directory (fail-open, one retry against root).
    function pickerBrowse(win, node, path) {
        if (!win || win.destroyed || win.destroying) {
            return;
        }
        var grid = win.down('#pickerGrid');
        if (grid) {
            try { grid.setLoading(true); } catch (e) { /* non-fatal */ }
        }
        ANAS.api.get(node, '/fs/browse?path=' + encodeURIComponent(path)).then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            if (grid) {
                try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
            }
            var d = (res && res.data) || {};
            if (d.type !== 'dir') {
                // Not a directory (missing / file / other) — fall back to root
                // once so the picker always lands somewhere navigable.
                if (path !== '/') {
                    pickerBrowse(win, node, '/');
                    return;
                }
                setPickerNote(win, t('Not a directory.'), true);
                return;
            }
            win._path = d.path || path;
            var pf = win.down('#pickerPath');
            if (pf) {
                try { pf.setValue(win._path); } catch (e) { /* non-fatal */ }
            }
            var rows = [];
            var dirs = isArray(d.dirs) ? d.dirs : [];
            for (var i = 0; i < dirs.length; i++) {
                rows.push({ name: '' + dirs[i] });
            }
            try {
                grid.getStore().loadData(rows);
            } catch (e2) {
                // non-fatal
            }
            // Silent truncation is banned — say so plainly when the flag is set.
            setPickerNote(win, d.truncated ? t('list truncated') : '', !!d.truncated);
        }, function (err) {
            if (win.destroyed || win.destroying) {
                return;
            }
            if (grid) {
                try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
            }
            // A browse error is fail-open: retry root once, else note it.
            if (path !== '/') {
                pickerBrowse(win, node, '/');
                return;
            }
            setPickerNote(win, t('Could not read directory') + ': ' + ANAS.errText(err), true);
        });
    }

    function openDirPicker(node, startPath, onSelect) {
        var start = trim(startPath) || '/';
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-fs-picker',
                title: t('Choose a directory'),
                modal: true,
                width: 520,
                height: 460,
                resizable: true,
                layout: { type: 'vbox', align: 'stretch' },
                items: [
                    {
                        xtype: 'fieldcontainer',
                        layout: 'hbox',
                        padding: '8 8 4 8',
                        items: [
                            {
                                xtype: 'textfield',
                                itemId: 'pickerPath',
                                cls: 'anas-fld-fs-path',
                                flex: 1,
                                selectOnFocus: true,
                                value: start,
                                listeners: {
                                    specialkey: function (f, e) {
                                        if (e.getKey() === e.ENTER) {
                                            pickerBrowse(win, node, trim(f.getValue()) || '/');
                                        }
                                    },
                                },
                            },
                            {
                                xtype: 'button',
                                text: t('Go'),
                                cls: 'anas-btn-fs-go',
                                margin: '0 0 0 6',
                                handler: function () {
                                    pickerBrowse(win, node, trim(valOf(win, '#pickerPath')) || '/');
                                },
                            },
                            {
                                xtype: 'button',
                                text: t('Up'),
                                cls: 'anas-btn-fs-up',
                                iconCls: 'fa fa-level-up',
                                margin: '0 0 0 6',
                                handler: function () {
                                    pickerBrowse(win, node, parentDir(win._path || valOf(win, '#pickerPath') || '/'));
                                },
                            },
                        ],
                    },
                    {
                        xtype: 'component',
                        itemId: 'pickerNote',
                        padding: '0 10',
                        html: '',
                    },
                    {
                        xtype: 'gridpanel',
                        itemId: 'pickerGrid',
                        cls: 'anas-grid-fs-picker',
                        flex: 1,
                        border: false,
                        hideHeaders: true,
                        store: Ext.create('Ext.data.Store', { fields: ['name'], data: [] }),
                        emptyText: t('No subdirectories'),
                        columns: [
                            {
                                text: t('Directory'),
                                dataIndex: 'name',
                                flex: 1,
                                sortable: false,
                                menuDisabled: true,
                                renderer: function (v) {
                                    return '<i class="fa fa-folder" style="margin-right:6px;'
                                        + 'color:var(--anas-accent,#3468c0);"></i>' + enc(v);
                                },
                            },
                        ],
                        listeners: {
                            itemdblclick: function (g, rec) {
                                pickerBrowse(win, node, joinDir(win._path || '/', rec.get('name')));
                            },
                        },
                    },
                ],
                buttons: [
                    { text: t('Cancel'), handler: function () { win.close(); } },
                    {
                        text: t('Select'),
                        cls: 'anas-btn-fs-select',
                        handler: function () {
                            var p = win._path || trim(valOf(win, '#pickerPath')) || '/';
                            if (onSelect) {
                                try { onSelect(p); } catch (e) { ANAS.warn('picker select failed: ' + ANAS.errText(e)); }
                            }
                            win.close();
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('directory picker window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
        // Start at the field's current value if it resolves to a dir, else '/'
        // (pickerBrowse handles the fallback).
        pickerBrowse(win, node, start);
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

    /** The per-archive nested summary line for the detail window (backup2.2). */
    function nestedDetailHtml(archive, scan) {
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

    function archivesBlock(task, scans) {
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
            var name = (a.name || '') + '.pxar';
            var excl = (a.excludes && a.excludes.length)
                ? '<div style="color:var(--anas-muted,gray);margin-top:2px;">'
                    + enc(t('excludes') + ': ' + a.excludes.join('  ')) + '</div>'
                : '';
            html += '<tr><td style="padding:3px 12px 3px 0;vertical-align:top;font-family:monospace;'
                + 'white-space:nowrap;color:var(--anas-accent,#3468c0);">' + enc(name) + '</td>'
                + '<td style="padding:3px 0;">' + mono(a.path) + excl
                + nestedDetailHtml(a, nestedScanFor(scans, a)) + '</td></tr>';
        }
        html += '</table></div>';
        return html;
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
                + enc(roots[r].name + '.pxar') + '</span>'
                + '<span style="color:var(--anas-muted,gray);"> ← </span>'
                + '<span style="font-family:monospace;">' + enc(roots[r].root) + '</span></div>';
        }
        return html + '</div>';
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

    function taskDetailHtml(d) {
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

        var rows = ''
            + kv(t('Task'), mono(task.name))
            + kv(t('Repository'), '<span style="font-family:monospace;font-size:0.92em;">' + repoText + '</span>')
            + kv(t('Backup ID'), mono('host/' + backupIdOf(task)))
            + kv(t('Change detection'), enc(modeLabel))
            + kv(t('Retention'), retentionRowHtml(task))
            + kv(t('Notifications'), notifyRowHtml(task))
            + kv(t('Schedule'), scheduleDetailHtml(task))
            + kv(t('Enabled'), task.enabled !== false
                ? '<span style="color:var(--anas-ok,#1f9c56);">' + enc(t('yes')) + '</span>'
                : '<span style="color:var(--anas-muted,gray);">' + enc(t('no')) + '</span>');

        var html = '<div style="padding:10px 14px;">'
            + '<table style="border-collapse:collapse;width:100%;">' + rows + '</table>';
        html += archivesBlock(task, d.nested);
        // The unit + timer, verbatim — config-is-the-API transparency (Principle 13).
        html += unitBlock(t('systemd service unit (as written)'), first(d.unit, d.serviceUnit));
        html += unitBlock(t('systemd timer (as written)'), first(d.timer, d.timerUnit));
        html += lastRunSnapshotBlock(d);
        html += recentRunsBlock(d);
        html += pbsLinkBlock(task);
        html += '</div>';
        return html;
    }

    // Fetch GET /backup/tasks/:name and render it into the detail window's body.
    // Called on open and by the window's Reload button — no polling.
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
            try {
                body.update(taskDetailHtml(res && res.data));
            } catch (e) {
                ANAS.warn('backup detail render failed: ' + ANAS.errText(e));
            }
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
    function openTaskDetailWindow(node, name) {
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
                                xtype: 'textfield',
                                itemId: 'archName',
                                cls: 'anas-fld-backup-arch-name',
                                fieldLabel: t('Archive name'),
                                labelWidth: 120,
                                flex: 1,
                                emptyText: 'etc',
                                value: bareArchive(data.name || ''),
                            },
                            {
                                xtype: 'component',
                                margin: '0 0 0 6',
                                style: 'line-height:24px;color:var(--anas-muted,gray);font-family:monospace;',
                                html: '.pxar',
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
                                    change: function () { scheduleNestedScan(fs, node); },
                                },
                            },
                            {
                                xtype: 'button',
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
            syncArchiveNested(fs);
            scanArchiveNested(fs, node);
        }
        return fs;
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
    function scanArchiveNested(fs, node) {
        if (!fs || fs.destroyed || fs.destroying) {
            return;
        }
        var pathF = fs.down('#archPath');
        var path = trim(pathF ? pathF.getValue() : '');
        if (!path || path.charAt(0) !== '/') {
            nestedAlertOut(fs, '');
            return;
        }
        var body = { path: path, includeNested: nestedFromRow(fs) };
        nestedAlertOut(fs, '<div style="font-size:11px;color:var(--anas-muted,gray);">'
            + '<i class="fa fa-refresh fa-spin" style="margin-right:5px;"></i>'
            + enc(t('checking for nested filesystems…')) + '</div>');
        ANAS.api.post(node, '/backup/tasks/preview-nested', body).then(
            function (res) {
                if (fs.destroyed || fs.destroying) {
                    return;
                }
                var d = (res && res.data) || {};
                var scans = isArray(d.archives) ? d.archives : [];
                nestedAlertOut(fs, nestedAlertHtml(scans[0]));
            },
            function (err) {
                if (fs.destroyed || fs.destroying) {
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
            var row = {
                name: name,
                path: path,
                excludes: splitLines(exclF ? exclF.getValue() : ''),
            };
            // backup2.2 — set / clear / keep: a chosen value is SENT, and None
            // is sent as NOTHING. Archives are replaced wholesale on every save,
            // so an omitted field IS the clear — and a task that never chose one
            // rewrites its unit byte-for-byte (the dialog ↔ daemon contract).
            var nested = nestedFromRow(fs);
            if (nested !== 'none') {
                row.includeNested = nested;
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

    function openTaskDialog(view, node, existing) {
        var isEdit = !!existing;
        var task = existing || {};
        loadRepoOptions(node).then(function (repoOpts) {
            if (!isEdit && !repoOpts.length) {
                ANAS.toast(t('Register a PBS repository first (Repositories…).'));
                return;
            }
            buildTaskWindow(view, node, isEdit, task, repoOpts);
        });
    }

    function buildTaskWindow(view, node, isEdit, task, repoOpts) {
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
                            xtype: 'fieldset',
                            title: t('Archives'),
                            cls: 'anas-backup-archives',
                            collapsible: false,
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
                            ],
                        },
                        {
                            xtype: 'fieldset',
                            title: t('Change detection'),
                            collapsible: false,
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
                                submitTask(win, view, node, isEdit, task);
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

        // Seed the archive rows. Edit → the task's archives; new → the suggested
        // etc.pxar:/etc default (the operator's own habit; removable = dismissible).
        var cont = win.down('#archivesContainer');
        if (cont) {
            var seed = archivesOf(task);
            if (!seed.length && !isEdit) {
                seed = [{ name: 'etc', path: '/etc', excludes: [] }];
            }
            if (!seed.length) {
                seed = [{ name: '', path: '', excludes: [] }];
            }
            for (var i = 0; i < seed.length; i++) {
                addArchiveRow(win, cont, pathStore, seed[i], node);
            }
        }
    }

    // `task` is the task being edited (empty on create): the source for every
    // field the dialog does NOT show but a PUT would otherwise drop.
    function submitTask(win, view, node, isEdit, task) {
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
        var archives = readArchives(win);
        if (!archives.length) {
            ANAS.alertMsg('Invalid input', t('Add at least one archive (a name and a path).'));
            return;
        }
        for (var i = 0; i < archives.length; i++) {
            if (!archives[i].name || !archives[i].path) {
                ANAS.alertMsg('Invalid input', t('Every archive needs both a name and a path.'));
                return;
            }
        }
        var mode = 'default';
        try {
            var mg = win.down('#modeGroup');
            var mv = mg && mg.getValue();
            if (mv && mv.mode) {
                mode = mv.mode;
            }
        } catch (eMode) {
            // default stands
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
        var name = rec.get('name');
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
                } catch (e) {
                    // best-effort summary
                }
                ANAS.toast(msg);
                if (warnings.length) {
                    try {
                        Ext.Msg.alert(t('Backup finished with a warning'), ANAS.warningsHtml(warnings));
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
                    tbar: [
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
                    ],
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
                                            emptyText: 'root@pam!anas',
                                            value: first(r.tokenId, r.tokenid) || '',
                                        },
                                        {
                                            xtype: 'textfield',
                                            itemId: 'tokenSecret',
                                            cls: 'anas-fld-backup-tokensecret',
                                            fieldLabel: t('Token secret'),
                                            inputType: 'password',
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
                                            emptyText: 'root@pam',
                                            value: first(r.username, r.user) || '',
                                        },
                                        {
                                            xtype: 'textfield',
                                            itemId: 'password',
                                            cls: 'anas-fld-backup-password',
                                            fieldLabel: t('Password'),
                                            inputType: 'password',
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
            '-',
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
                    var rec = selectedTask(gridOf(btn.up('#backupView')));
                    if (rec) {
                        openTaskDetailWindow(node, rec.get('name'));
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
                    tbar: tbar,
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
