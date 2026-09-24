/*
 * ANAS — Schedules shared helpers (Epic 17). The Snapshots view (69-snapshots.js)
 * and the Scrubs view (69-scrubs.js) were split out of one "Schedules" screen; the
 * bits BOTH genuinely share live here ONCE (single-source-of-truth) rather than as
 * two copies that drift apart:
 *   - the filesystem-tag chip (zfs / ahr) — the two views must read IDENTICALLY
 *     (parallel construction: a ZFS and an AHR row look the same),
 *   - the small state pills (pill / soft pill / muted dash),
 *   - the visibility-gated poll loop (start / stop / cleanup) — ~identical machinery
 *     both views need; duplicating it would be a real SSOT violation.
 *
 * Trivial per-file wrappers (`t`, `enc`) stay local in each view, matching the
 * house style of the other screens (replication/backup each carry their own).
 *
 * Exposed as `ANAS.sched.*`. Plain ES5 to match PVE's compiled ExtJS bundle.
 * Fail-open everywhere — a broken helper never breaks the host page.
 */
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.ANAS) {
        return;
    }

    var ANAS = window.ANAS;
    var sched = ANAS.sched = ANAS.sched || {};

    // Reload cadence while a schedules view is visible — matches replication.
    sched.POLL_MS = 10000;

    function enc(s) {
        return ANAS.enc(s);
    }

    // The cadence widget (rclone.3) renders labels through the translation
    // wrapper too — this file's other helpers stayed raw because the two
    // schedules views carry their own `t`; the shared widget cannot.
    function t(str) {
        return ANAS.t ? ANAS.t(str) : str;
    }

    // The filesystem-tag chip ("ZFS"/"AHR") shared by the Snapshots target column
    // and the Scrubs pool column — one renderer so the two read identically.
    sched.fsTag = function (kind, title) {
        return '<span class="anas-sched-fs-tag"' + (title ? ' title="' + enc(title) + '"' : '')
            + ' style="display:inline-block;padding:0 6px;margin-right:6px;border-radius:8px;'
            + 'font-size:0.78em;text-transform:uppercase;letter-spacing:0.04em;'
            + 'color:var(--anas-accent,#3468c0);'
            + 'background:color-mix(in srgb,var(--anas-accent,#3468c0) 14%,transparent);">'
            + enc(kind || 'zfs') + '</span>';
    };

    // Solid state pill (enabled / success / failure / on).
    sched.pillHtml = function (label, color, title) {
        return '<span' + (title ? ' title="' + enc(title) + '"' : '')
            + ' style="display:inline-block;padding:1px 9px;border-radius:9px;font-size:0.85em;'
            + 'color:#fff;background:' + color + ';">' + enc(label) + '</span>';
    };

    // Soft (tinted) pill — for muted / neutral states (disabled, off, never-run).
    sched.softPill = function (label, color, title) {
        return '<span' + (title ? ' title="' + enc(title) + '"' : '')
            + ' style="display:inline-block;padding:1px 9px;border-radius:9px;font-size:0.85em;'
            + 'color:' + color + ';background:color-mix(in srgb,' + color + ' 15%,transparent);">'
            + enc(label) + '</span>';
    };

    sched.muted = function (html) {
        return '<span style="color:var(--anas-muted,gray);">' + html + '</span>';
    };

    // Absolute local timestamp ("2026-08-03 07:23") for an ISO instant. Both
    // views print times — the Snapshots last/next run and the Scrubs last-scrub
    // verdict — and they must read identically, so the formatting lives here
    // once. Fail-soft: an unparseable value is echoed rather than blanked.
    sched.absTime = function (iso) {
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
    };

    // ---- Session run errors (rclone.3; backup gained it with the same fix) --
    //
    // systemd's last-result says `failure`; the LINE that says why is in
    // journald, and the grid payload carries neither. A run the user started
    // from this grid does have it — the job's error — so it is remembered for
    // as long as the tab lives and shown as the failed cell's tooltip.
    //
    // Kept on the STORE (which survives a `loadData`, so a reload never forgets
    // what this user watched fail) and KEYED TO THE RUN it came from: a line
    // left over from an earlier failure must not be hung under a later run's
    // timestamp, which would be a lie about what went wrong this time.
    //
    // The binding is two-step because the error is recorded BEFORE the reload
    // that brings the new run's `lastRunAt` in: `set` records the timestamp the
    // row carried at that moment (`prev`), and the first read whose timestamp
    // has moved past it binds the line to that run. From then on the line shows
    // for that run only, and any later run drops it.
    var runErrors = {};

    function runErrText(v) {
        return (v === undefined || v === null) ? null : ('' + v);
    }

    function runErrBag(store) {
        if (!store) {
            return null;
        }
        if (!store._anasRunErrors) {
            store._anasRunErrors = {};
        }
        return store._anasRunErrors;
    }

    runErrors.set = function (store, name, msg, prevAt) {
        try {
            var bag = runErrBag(store);
            if (!bag || !name || !msg) {
                return;
            }
            bag['' + name] = { at: undefined, prev: runErrText(prevAt), msg: '' + msg };
        } catch (e) {
            // A tooltip is never worth breaking a grid for.
        }
    };

    runErrors.clear = function (store, name) {
        try {
            var bag = store && store._anasRunErrors;
            if (bag && name) {
                delete bag['' + name];
            }
        } catch (e) {
            // non-fatal
        }
    };

    // The line for the run the row is showing, or '' when there is none for it.
    runErrors.get = function (store, name, at) {
        try {
            var bag = store && store._anasRunErrors;
            var entry = (bag && name) ? bag['' + name] : null;
            if (!entry) {
                return '';
            }
            var now = runErrText(at);
            if (entry.at === undefined) {
                // Still unbound. While the row shows the timestamp it carried
                // when the failure was recorded, the reload has not landed yet.
                if (now === entry.prev) {
                    return entry.msg;
                }
                entry.at = now;
                return entry.msg;
            }
            if (entry.at !== now) {
                delete bag['' + name];
                return '';
            }
            return entry.msg;
        } catch (e) {
            return '';
        }
    };

    sched.runErrors = runErrors;

    // The failed-cell tooltip both grids show: the run's own error line when
    // this session has one, otherwise the time and where the history is.
    sched.runErrorTip = function (store, name, at) {
        var line = runErrors.get(store, name, at);
        if (line) {
            return line;
        }
        var abs = sched.absTime(at);
        return (abs ? abs + ' — ' : '') + t('open Details for the recent runs');
    };

    // ---- Visibility-gated poll loop (no leaked intervals) ------------------
    // Each view supplies its own `refresh(quiet)` closure (which grids to reload);
    // this owns the interval + the visibilitychange handler, stored on the view so
    // stop/cleanup can tear both down. Idempotent: starting twice never doubles up.

    sched.stopPolling = function (view) {
        try {
            if (view && view._anasTimer) {
                clearInterval(view._anasTimer);
                view._anasTimer = null;
            }
        } catch (e) {
            // non-fatal
        }
    };

    sched.startPolling = function (view, refresh) {
        if (!view || view.destroyed || view.destroying) {
            return;
        }
        if (refresh) {
            view._anasRefresh = refresh;
        }
        sched.stopPolling(view);
        try {
            view._anasTimer = setInterval(function () {
                try {
                    if (!view || view.destroyed || view.destroying) {
                        sched.stopPolling(view);
                        return;
                    }
                    if (typeof document !== 'undefined' && document.hidden) {
                        return;
                    }
                    if (typeof view.isVisible === 'function' && !view.isVisible()) {
                        return;
                    }
                    if (view._anasRefresh) {
                        view._anasRefresh(view, true);
                    }
                } catch (tickErr) {
                    ANAS.warn('schedules poll tick failed: ' + ANAS.errText(tickErr));
                }
            }, sched.POLL_MS);
        } catch (e) {
            ANAS.warn('schedules interval start failed: ' + ANAS.errText(e));
        }
        // Wire the tab-visibility handler once per view.
        try {
            if (!view._anasVisHandler && typeof document !== 'undefined' && document.addEventListener) {
                view._anasVisHandler = function () {
                    try {
                        if (document.hidden) {
                            sched.stopPolling(view);
                        } else if (typeof view.isVisible === 'function' && view.isVisible()) {
                            sched.startPolling(view);
                        }
                    } catch (e2) {
                        // non-fatal
                    }
                };
                document.addEventListener('visibilitychange', view._anasVisHandler);
            }
        } catch (e3) {
            // non-fatal
        }
    };

    sched.cleanupPolling = function (view) {
        sched.stopPolling(view);
        try {
            if (view && view._anasVisHandler && typeof document !== 'undefined'
                && document.removeEventListener) {
                document.removeEventListener('visibilitychange', view._anasVisHandler);
                view._anasVisHandler = null;
            }
        } catch (e) {
            // non-fatal
        }
    };

    // The standard listeners block a schedules view uses — refresh + poll while
    // visible, tear everything down on destroy. `refresh(view, quiet)` is the
    // view's own (which grid(s) to reload).
    sched.viewListeners = function (refresh) {
        return {
            afterrender: function (v) { refresh(v, false); sched.startPolling(v, refresh); },
            activate: function (v) { refresh(v, false); sched.startPolling(v, refresh); },
            deactivate: function (v) { sched.stopPolling(v); },
            show: function (v) { sched.startPolling(v, refresh); },
            hide: function (v) { sched.stopPolling(v); },
            beforedestroy: function (v) { sched.cleanupPolling(v); },
            destroy: function (v) { sched.cleanupPolling(v); }
        };
    };

    // ======================================================================
    //  The cadence widget (16.10), extracted from 68-backup.js (rclone.3)
    // ======================================================================
    //
    // A task's schedule is still an OnCalendar expression; `cadence` is the
    // structured form a wizard edits, and the DAEMON generates the expression
    // from it (the generator lives once, in the shared schema — no view ever
    // reimplements systemd calendar syntax). A task without a cadence is a raw
    // OnCalendar task, which is what every pre-16.10 task is: it opens on the
    // Custom tab with its expression prefilled, and saving it changes nothing.
    //
    // The Backup task wizard (68-backup.js) was its only user until the Cloud
    // Sync task wizard (72-cloud.js, rclone.3) needed the identical widget —
    // parallel construction: like things function similarly. It lives here ONCE
    // and both dialogs delegate (`sched.cadence.*`); nothing about the Backup
    // wizard's own copy changed but where it is defined.
    //
    // NOTHING here mirrors form state through a hiddenfield (issue #26): a
    // Text-class getValue() hands back DOM strings, where the string 'false' is
    // truthy. Every value is read straight off its own field by itemId, radios
    // by string compare and checkboxes by an explicit === true.

    var cad = sched.cadence = sched.cadence || {};

    cad.WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    cad.WEEKDAY_LABEL = {
        Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday',
        Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday',
    };
    cad.KINDS = ['weekly', 'biweekly', 'monthly', 'custom'];
    cad.TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
    // The fire time the operator's own jobs use — a sane default, freely editable.
    cad.DEFAULT_TIME = '02:00';

    cad.NOTE = {
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

    function cadTrim(v) {
        return ('' + (v == null ? '' : v)).replace(/^\s+|\s+$/g, '');
    }

    function cadValOf(win, sel) {
        try {
            var f = win.down(sel);
            return f ? f.getValue() : undefined;
        } catch (e) {
            return undefined;
        }
    }

    // A task's cadence, normalised; null when the task carries a raw schedule.
    //
    // `parity` is OMITTED when the task carries none. The shared schema types
    // it `z.enum(['even','odd']).optional()`, so an empty string is not "no
    // parity" to it — it is an invalid enum member, and a whole-task PUT built
    // from this object (the enable/disable toggle on a weekly or monthly task)
    // came back a 400.
    cad.of = function (task) {
        var c = task && task.cadence;
        if (!c || cad.KINDS.indexOf('' + c.kind) < 0 || c.kind === 'custom') {
            return null;
        }
        var days = [];
        // A REAL array test: a string has a `length` too, and iterating one
        // character by character would silently produce an empty day list.
        var raw = (Object.prototype.toString.call(c.days) === '[object Array]') ? c.days : [];
        for (var i = 0; i < cad.WEEKDAYS.length; i++) {
            for (var j = 0; j < raw.length; j++) {
                if (raw[j] === cad.WEEKDAYS[i]) {
                    days.push(cad.WEEKDAYS[i]);
                    break;
                }
            }
        }
        var out = {
            kind: '' + c.kind,
            days: days,
            time: '' + (c.time || ''),
        };
        if (c.parity) {
            out.parity = '' + c.parity;
        }
        return out;
    };

    // A cadence in words. Deliberately spells out what the timer alone cannot say
    // (which weeks a biweekly task runs) — the whole point of the feature.
    cad.text = function (c) {
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
    };

    function cadWeekdayOptions() {
        var data = [];
        for (var i = 0; i < cad.WEEKDAYS.length; i++) {
            data.push({ v: cad.WEEKDAYS[i], label: t(cad.WEEKDAY_LABEL[cad.WEEKDAYS[i]]) });
        }
        return data;
    }

    // The Schedule fieldset. `cadence` is null for a raw-OnCalendar task, which
    // opens on Custom with its expression prefilled — no migration, no surprise.
    //
    // `pfx` names the caller's screen for the hook classes ('backup' — the
    // original — or 'cloud'); the itemIds are the widget's own either way, so
    // the readers below (and the harness) address both dialogs identically.
    cad.fieldset = function (cadence, task, onChange, pfx) {
        pfx = pfx || 'backup';
        var kind = cadence ? cadence.kind : 'custom';
        var days = cadence ? cadence.days : [];
        var time = (cadence && cadence.time) || cad.DEFAULT_TIME;
        var parity = (cadence && cadence.parity) || 'even';
        var oneDay = days.length ? days[0] : 'Sun';

        var dayBoxes = [];
        for (var i = 0; i < cad.WEEKDAYS.length; i++) {
            var d = cad.WEEKDAYS[i];
            dayBoxes.push({
                xtype: 'checkboxfield',
                itemId: 'day' + d,
                cls: 'anas-fld-' + pfx + '-day',
                boxLabel: t(d),
                checked: days.indexOf(d) >= 0,
                width: 66,
            });
        }

        return {
            xtype: 'fieldset',
            title: t('Schedule'),
            cls: 'anas-' + pfx + '-schedule',
            collapsible: false,
            defaults: { anchor: '100%', labelWidth: 130 },
            items: [
                {
                    xtype: 'radiogroup',
                    itemId: 'cadenceKind',
                    cls: 'anas-fld-' + pfx + '-cadence',
                    // The caller's screen name, carried on the widget so the
                    // readers below can put it back in front of a warning.
                    anasPfx: pfx,
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
                                ANAS.warn(pfx + ' cadence toggle failed: ' + ANAS.errText(e));
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
                    cls: 'anas-fld-' + pfx + '-single-day',
                    fieldLabel: t('Day'),
                    store: Ext.create('Ext.data.Store', { fields: ['v', 'label'], data: cadWeekdayOptions() }),
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
                    cls: 'anas-fld-' + pfx + '-parity',
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
                    cls: 'anas-fld-' + pfx + '-time',
                    fieldLabel: t('Time'),
                    emptyText: cad.DEFAULT_TIME,
                    width: 260,
                    anchor: null,
                    value: time,
                    regex: cad.TIME_RE,
                    regexText: t('A 24-hour time, HH:MM.'),
                },
                {
                    xtype: 'textfield',
                    itemId: 'schedule',
                    cls: 'anas-fld-' + pfx + '-schedule',
                    fieldLabel: t('OnCalendar'),
                    emptyText: 'daily',
                    value: (task.schedule || ''),
                },
                {
                    xtype: 'component',
                    itemId: 'cadenceNote',
                    style: 'color:var(--anas-muted,gray);font-size:11px;margin:2px 0 0 134px;',
                    html: enc(t(cad.NOTE[kind] || cad.NOTE.custom)),
                },
            ],
        };
    };

    // The screen a cadence widget belongs to ('backup' / 'cloud'), for the
    // warnings the readers below raise — the widget stamps it on itself.
    function cadPfxOf(win) {
        try {
            var g = win.down('#cadenceKind');
            return (g && g.anasPfx) ? ('' + g.anasPfx) : 'backup';
        } catch (e) {
            return 'backup';
        }
    }

    // The chosen cadence kind, read off the radiogroup by itemId (string compare).
    cad.kindOf = function (win) {
        try {
            var g = win.down('#cadenceKind');
            var v = g && g.getValue();
            var k = '' + ((v && v.cadenceKind) || '');
            return cad.KINDS.indexOf(k) >= 0 ? k : 'custom';
        } catch (e) {
            return 'custom';
        }
    };

    // Show only the fields the chosen kind actually uses.
    cad.syncFields = function (win) {
        var kind = cad.kindOf(win);
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
                note.update(enc(t(cad.NOTE[kind] || cad.NOTE.custom)));
            }
        } catch (e2) {
            ANAS.warn(cadPfxOf(win) + ' cadence note failed: ' + ANAS.errText(e2));
        }
    };

    // Build the cadence object for a non-custom kind, or null after alerting.
    // Validated here AND in the daemon (defence in depth, never frontend-only).
    cad.read = function (win) {
        var kind = cad.kindOf(win);
        var time = cadTrim(cadValOf(win, '#cadenceTime'));
        if (!cad.TIME_RE.test(time)) {
            ANAS.alertMsg('Invalid input', t('Enter a time as HH:MM (24-hour).'));
            return null;
        }
        var days = [];
        if (kind === 'weekly') {
            var row = win.down('#weeklyDaysRow');
            for (var i = 0; i < cad.WEEKDAYS.length; i++) {
                var cb = row && row.down('#day' + cad.WEEKDAYS[i]);
                if (cb && cb.getValue() === true) {
                    days.push(cad.WEEKDAYS[i]);
                }
            }
            if (!days.length) {
                ANAS.alertMsg('Invalid input', t('Choose at least one weekday.'));
                return null;
            }
        } else {
            var one = cadTrim(cadValOf(win, '#singleDay'));
            if (cad.WEEKDAYS.indexOf(one) < 0) {
                ANAS.alertMsg('Invalid input', t('Choose a weekday.'));
                return null;
            }
            days = [one];
        }
        var out = { kind: kind, days: days, time: time };
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
            out.parity = parity;
        }
        return out;
    };
})();
