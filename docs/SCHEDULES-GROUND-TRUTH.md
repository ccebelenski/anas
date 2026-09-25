# Epic 17 — Schedules Stunt-Node Ground Truth (Stage 0)

> Captured 2026-07-26 on the stunt node (`anas-pve`, 192.168.200.50) — PVE
> `pve-manager/9.2.5`, kernel `7.0.14-6-pve`, ZFS `2.4.3-pve1`, **sanoid
> `2.2.0-2`** (installed fresh from Debian trixie/main). This is Stage 0 for
> Epic 17 (scheduled snapshots & scrubs): capture facts, pick the tool, grab
> real config fixtures — **no parser, no feature code**. All facts below were
> observed from real command output; the durable copies of every config/unit
> file live under `packages/daemon/src/fixtures/schedules/` (see its NOTES.md).
>
> The AHR-2 headline pool `tank` (md + LVM + btrfs) and the `:8006` ANAS
> transport were left untouched throughout. The ZFS holds-vs-prune test ran on a
> **throwaway 2 GiB loop-file zpool `santest`**, fully destroyed afterward — the
> node has **no ZFS pool** of its own (its root is not ZFS; `tank` is btrfs/AHR,
> not ZFS). sanoid remains installed (harmless — its service no-ops without a
> config).

## Tool decision

**Winner: `sanoid` (2.2.0-2).** Confirmed against `zfs-auto-snapshot`:

- **Packaging** — sanoid is in Debian 13 (trixie) `main` at 2.2.0-2, one
  `apt-get install` (pulls `libconfig-inifiles-perl`, `pv`, `mbuffer`,
  `libcapture-tiny-perl`). It ships its own systemd timer + services. No
  third-party repo, no build step — satisfies Principle 8.
- **Retention-policy fit** — sanoid's core competency is exactly what 17.4
  needs: named templates with `hourly/daily/weekly/monthly/yearly` counts,
  `autosnap`/`autoprune`, `recursive`, and `use_template=` composition. This is
  a declarative retention model in an INI config. `zfs-auto-snapshot` is
  cron-driven `--keep=N` per-frequency with no template/policy layer and no
  single config surface to parse — a poor fit for a "policy summary" grid (17.3)
  and surgical config editing (17.2). sanoid's config IS the API (Principle 13).
- **Scheduler leverage** — sanoid does NOT implement its own scheduler; the
  distro ships a systemd timer that invokes it. We wire up the existing timer,
  never build a scheduler (PRINCIPLES §7, standing scheduling ruling). ✅
- **Hold-safety** — verified live (SCHEDULES-GT-7): sanoid's prune cannot
  destroy a `zfs hold`-protected snapshot; ZFS refuses and sanoid continues
  non-fatally. Replication's incremental base is safe. ✅

`sanoid` was the presumptive pick and it held up. Decision closed.

---

## Facts the code must honor (numbered for reference)

### Scrubs — the PVE/Debian default (17.5)

**SCHEDULES-GT-1 — A stock PVE node ALREADY auto-scrubs every pool monthly, via
CRON — not systemd.** `zfsutils-linux` ships `/etc/cron.d/zfsutils-linux`
(verbatim in the fixtures) with:

```
# Scrub the second Sunday of every month.
24 0 8-14 * * root if [ $(date +\%w) -eq 0 ] && [ -x /usr/lib/zfs-linux/scrub ]; then /usr/lib/zfs-linux/scrub; fi
```

This runs `/usr/lib/zfs-linux/scrub` on the 2nd Sunday 00:24 monthly (there is
also a monthly TRIM on the 1st Sunday). **17.5 MUST recognize this so it never
double-schedules.** This is the "distro/PVE default scrub" the story calls out.

**SCHEDULES-GT-2 — The cron scrub is gated per-pool by a ZFS user property, not
a config file.** `/usr/lib/zfs-linux/scrub` (fixtures: `zfs-linux-scrub.sh`)
reads `org.debian:periodic-scrub` off each pool's **root dataset**:

- `-` (unset, the default), `auto`, or `enable` → **scrubs the pool**.
- `disable` → skips.
- Only `ONLINE` (healthy) pools are scrubbed; in-progress scrubs are left alone.

Observed on a fresh loop zpool: `zfs get org.debian:periodic-scrub santest` →
value `-`, source `-`. **So out of the box, every healthy pool IS scrubbed
monthly** (default = scrub). The knob to turn the default OFF is
`zfs set org.debian:periodic-scrub=disable <pool>` — a ZFS property, applied
surgically, NOT a config-file or unit edit. 17.5 surfaces/toggles THIS.

**SCHEDULES-GT-3 — systemd scrub timers exist but are DISABLED by default, and
are per-pool template units.** `zfs-scrub-monthly@.timer` and
`zfs-scrub-weekly@.timer` (fixtures) are `disabled`; `zfs-scrub@.service` is
`static`. They take a pool instance name:
`systemctl enable --now zfs-scrub-weekly@rpool.timer`. They are the mechanism
for a *non-default cadence* (e.g. weekly). Templates: `OnCalendar=monthly` /
`weekly`, `Persistent=true`, `RandomizedDelaySec=1h`. The service
(`zfs-scrub@.service`) waits for the scrub (`zpool scrub -w`, or attaches to one
already running), `ConditionACPower=true`.

**SCHEDULES-GT-4 — The two scrub mechanisms can COLLIDE.** If ANAS enables a
`zfs-scrub-*@<pool>.timer` for a pool while `org.debian:periodic-scrub` is still
default (`-`/`auto`), the pool is scheduled by BOTH the systemd timer and the
monthly cron — a double-scrub. 17.5's design must pick ONE lever per pool:
either toggle the property (adjust/disable the cron default) **or** own the
systemd timer AND set the property to `disable`. The Schedules grid (17.3) must
read BOTH sources to show the true state and flag the overlap.

### Snapshots — sanoid config format + units (17.2, 17.3, 17.4)

**SCHEDULES-GT-5 — sanoid config: `/etc/sanoid/sanoid.conf`, INI, does NOT exist
until created.** The package ships NO `/etc/sanoid/` dir; the service is gated
`ConditionFileNotEmpty=/etc/sanoid/sanoid.conf`, so sanoid no-ops until ANAS (or
the admin) writes one. Two read-only reference files ship and are the parser's
north stars (both in fixtures verbatim):

- `/usr/share/sanoid/sanoid.defaults.conf` — the `[template_default]` with EVERY
  allowable key + factory defaults (`hourly=48 daily=90 monthly=6`, others 0;
  `autoprune=yes autosnap=1 frequent_period=15`; monitoring warn/crit; capacity
  checks). **This file is also sanoid's key whitelist** (see GT-9).
- `/usr/share/doc/sanoid/examples/sanoid.conf` — shipped example: per-dataset
  stanzas + templates + comments.

INI shape the 17.2 parser must round-trip:

- `[version]` stanza with `version = 2`.
- **Per-dataset stanzas** keyed by the ZFS path with NO leading slash:
  `[tank/media]`. Keys: `use_template = a,b` (comma list, order-significant,
  later wins), plus any template key inline to override
  (`hourly`, `daily`, ...). `recursive = yes` (per-child) or `recursive = zfs`
  (atomic recursive), `process_children_only`, `skip_children`.
- **Template stanzas** named `[template_<name>]`. Retention counts
  `frequently/hourly/daily/weekly/monthly/yearly` (0 = don't keep AND immediately
  prune that type — see GT-7), `autosnap`, `autoprune`, `frequent_period`,
  timing anchors (`daily_hour/daily_min`, `weekly_wday`, `monthly_mday`, ...),
  script hooks (`pre_snapshot_script`, `pruning_script`, `script_timeout`, ...),
  monitoring (`monitor`, `*_warn`, `*_crit`, `capacity_warn/crit`).
- Indentation is by TAB in the shipped files but is cosmetic (INI). Comments are
  `#` full-line and trailing. The parser must preserve comments, ordering, tabs,
  and stanza order (surgical editing — Principle 12/13).

**SCHEDULES-GT-6 — sanoid's units: split take/prune, NOT `--cron`; timer enabled
on install, every 15 min.** (All three in fixtures.)

- `sanoid.timer` — `OnCalendar=*:0/15` (every 15 minutes), `Persistent=true`.
  **Enabled automatically by the package install** (`timers.target.wants`
  symlink created). But harmless until a config exists (service condition).
- `sanoid.service` — `Type=oneshot`, `ExecStart=/usr/sbin/sanoid
  --take-snapshots --verbose`, `Wants=`+`Before=sanoid-prune.service`,
  `ConditionFileNotEmpty=/etc/sanoid/sanoid.conf`, `Environment=TZ=UTC`.
- `sanoid-prune.service` — `Type=oneshot`, `ExecStart=/usr/sbin/sanoid
  --prune-snapshots --verbose`, `WantedBy=sanoid.service` (so a service run does
  take-then-prune). `static`.

So invocation is **timer → take-snapshots → prune-snapshots**, every 15 min, and
sanoid itself decides per-run whether any snapshot is actually due (from the
config's cadence/anchors) and what to prune. ANAS does NOT schedule per-dataset
timers — one shared 15-min timer drives everything; the config is the policy.
`sanoid` version string: `/usr/sbin/sanoid version 2.2.0`.

### The holds-vs-prune trap (17.6) — OBSERVED

**SCHEDULES-GT-7 — sanoid does NOT skip held snapshots; it TRIES to destroy them,
ZFS refuses, sanoid warns non-fatally and moves on. The held snapshot always
survives; the run exits 0.** Live-proven on `santest/data`: 4 sanoid-named daily
snapshots, `zfs hold anasrepl` on the oldest (the replication-incremental-base
analog), template forced to `daily = 0` (immediate-prune-all path). Result:

```
INFO: pruning santest/data@autosnap_2026-07-22_00:00:00_daily ...
cannot destroy snapshot ...: it's being held. Run 'zfs holds -r ...' to see holders.
could not remove santest/data@autosnap_2026-07-22_00:00:00_daily : 256 at /usr/sbin/sanoid line 360.
INFO: pruning santest/data@autosnap_2026-07-25_00:00:00_daily ...   (destroyed)
INFO: pruning santest/data@autosnap_2026-07-24_00:00:00_daily ...   (destroyed)
INFO: pruning santest/data@autosnap_2026-07-23_00:00:00_daily ...   (destroyed)
PRUNE_EXIT=0
```

- The 3 UNHELD snapshots were destroyed; the HELD one **survived** (`userrefs=1`).
- sanoid used Perl `warn` (source line 360: `warn "could not remove $snap : $?"`)
  — **stderr warning, non-fatal**. The overall run still exits **0**.
- Confirmed on a 2nd run: it **retries the held snapshot every run**, same
  warning, still survives, still exit 0. It does NOT loop within a run and does
  NOT hard-fail — but it also never stops trying across runs.

**Implications for 17.6:** the incremental base is SAFE (ZFS is the backstop, not
sanoid). But sanoid emits a recurring per-run stderr warning for each held
snapshot — noisy, and it reports it as a *failed destroy* (line 360, `$? = 256`),
NOT as an intentional "skipped by hold." So ANAS must, on its own, detect held
snapshots (`zfs holds`, or `userrefs > 0` on `zfs list -t snapshot -o
name,userrefs`) and present them as **intentionally retained (held for
replication)** rather than as prune errors — so the operator isn't alarmed by
sanoid's warning and doesn't think pruning is broken. 17.6's "surfaced, not
silently retried forever" = surface the held-and-skipped state from ZFS
userrefs/holds; the retry is sanoid's behavior we annotate, not fight.

### The parser gotcha (17.2)

**SCHEDULES-GT-8 — sanoid resolves defaults from `sanoid.defaults.conf` +
`[template_default]`.** Any value not set in a per-dataset stanza or its
`use_template` chain falls through to `[template_default]` in
`/etc/sanoid/sanoid.conf` (if present) then to the shipped defaults file. The
17.3 "policy summary" must resolve the effective values through this chain
(dataset inline > templates in listed order > local `[template_default]` >
shipped defaults), not just print the stanza's literal keys.

**SCHEDULES-GT-9 — sanoid is STRICT: an unknown key is a FATAL ERROR (exit 255),
not a warning.** Observed: a config with `anas_exotic_key = banana` →
`FATAL ERROR: I don't understand the setting anas_exotic_key you've set in
[template_anas] in /etc/sanoid/sanoid.conf` (exit 255) — sanoid validates every
key against the `sanoid.defaults.conf` whitelist and refuses to run otherwise.
Consequences for 17.2:

- The round-trip parser must **preserve** unknown directives on read (surgical
  fidelity — a foreign config we don't own may legitimately be broken), BUT
- ANAS's writer/validator must **reject** unknown keys before writing (or it
  would render the config unrunnable and break every dataset's snapshots).
- The set of legal keys is EXACTLY the keys present in
  `sanoid.defaults.conf` — the parser/validator should source its whitelist from
  that shipped file, not a hand-maintained list (it can drift with the package).
- (Contrast: unknown template NAMES via `use_template=` are tolerated more
  loosely, but an unknown *setting* is fatal — verified.)

---

## What the 17.2 parser must handle (summary)

- INI with `[version]`, `[template_<name>]`, and `[pool/dataset]` (no leading
  slash) stanza classes; tabs for indent; `#` full-line and trailing comments.
- Preserve comment/ordering/whitespace/unknown-directive fidelity (surgical).
- `use_template = a,b` comma lists (order-significant) + inline per-key overrides.
- `recursive = yes | zfs`, `process_children_only`, `skip_children`.
- Effective-value resolution through the defaults/template chain (GT-8).
- Whitelist validation sourced from `sanoid.defaults.conf`; reject unknown keys
  before write (GT-9) while preserving them on read.

## What the 17.3 screen must handle (summary)

- Snapshot schedules from `sanoid.conf` stanzas + effective policy summary
  (e.g. "36h / 30d / 3m"), enabled = has a stanza with `autosnap`.
- Last run / result: sanoid is timer-driven (one 15-min timer); run detail is
  `systemctl status sanoid.service` / journald (forensics only). Snapshot
  reality = `zfs list -t snapshot` counts per dataset; held snapshots via
  `userrefs`/`zfs holds` (surface as held, GT-7).
- Scrub schedules from BOTH sources (GT-1..4): the monthly cron default gated by
  `org.debian:periodic-scrub` per pool, AND any enabled `zfs-scrub-*@<pool>`
  systemd timer. Flag the double-schedule overlap. Scrub reality/last-result =
  `zpool status` scrub line. Overdue highlighting per the replication precedent.

## Surprises / notes

- The scrub default is a **cron + ZFS user-property** mechanism, not systemd —
  easy to miss if you only `systemctl list-timers`. The systemd scrub timers are
  a *second, disabled* mechanism. Don't assume systemd is the source of truth
  for scrubs (contrast snapshots, which ARE systemd-timer-driven via sanoid).
- sanoid's every-15-min timer is enabled on install but inert without a config —
  installing the package is safe and does not start snapshotting anything.
- The stunt node has no ZFS pool of its own; Epic 17 ZFS proofs need a
  throwaway loop zpool (as done here) or a real pool on pve5/pve10/pve14 (prod —
  observe only, never mutate).

---

# Stage 2 — Schedule store + systemd timers + scrub toggle (2026-07-26)

> Captured live on the stunt node (`anas-pve`, 192.168.200.50) — systemd 257
> (257.13-1~deb13u1), mdadm v4.4, kernel 7.0.14-6-pve. The daemon runs from
> `/opt/anas/packages/daemon/dist/index.js`, so the schedule runner ships at
> `/opt/anas/packages/daemon/dist/snapshot-task.js` (matches replicate-task /
> backup-task). ZFS proof used a throwaway 300 MiB loop zpool `santest` (created,
> exercised, destroyed). The AHR headline pool `tank` (md126/md127 raid5) was
> READ ONLY throughout — never scrubbed or toggled.

## Facts the code honors (stage-2, numbered continuing from GT-9)

**SCHEDULES-GT-10 — cadence → OnCalendar, verified against `systemd-analyze
calendar`.** Every retention bucket maps to a systemd calendar SHORTCUT except
`frequently` (no shortcut → `*:0/15`). Normalized forms observed:
`daily`→`*-*-* 00:00:00`, `hourly`→`*-*-* *:00:00`, `weekly`→`Mon *-*-* 00:00:00`,
`monthly`→`*-*-01 00:00:00`, `yearly`→`*-01-01 00:00:00`, `*:0/15`→
`*-*-* *:00/15:00`. The cadence that fires a snapshot is also the bucket it is
named/retained in, so cadence and retention stay aligned by construction. The
generated `.timer` (`OnCalendar=<cadence>`, `Persistent=true`,
`WantedBy=timers.target`) passes `systemd-analyze verify` with ZERO warnings, as
does the `.service` (`Type=oneshot`, `Environment=TZ=UTC`, ExecStart the runner).

**SCHEDULES-GT-11 — the units-as-store pattern transfers verbatim from
replication/backup.** `anas-snap-<id>.{service,timer}` with the canonical
`SnapshotSchedule` JSON embedded as an `# X-ANAS-Schedule=` service comment (the
ONLY thing parsed back). Create writes both files → `daemon-reload` →
`enable --now` the timer; delete does `disable --now` → unlink both →
`daemon-reload`. Live: create enabled the timer (`is-enabled` = `enabled`,
`nextRunAt` = next 00:00 UTC); delete left NO files and `is-enabled` = not-found.
Status is systemd-derived (a never-run oneshot reads `Result=success`,
`ActiveState=inactive` → `lastRunResult:"success"` with `lastRunAt:null` until it
first runs — same benign default as backup tasks).

**SCHEDULES-GT-12 — the timer→runner→fire path works end to end.**
`systemctl start anas-snap-<id>.service` ran `node dist/snapshot-task.js --id …`,
which POSTed `/v1/schedules/:id/run` over the daemon socket; the daemon took the
snapshot then pruned, and the runner printed the result JSON to journald:
`{"schedule":"santest-daily","result":{"taken":"anas-daily-2026-07-26T194435Z",
"pruned":[],"skippedHeld":[]}}`. A second fire 6 s later took a new
`anas-daily-…194441Z` and PRUNED the older one (`retention daily=1` → exactly 1
`anas-daily` snapshot survived). ExecStart exit 0; systemd's own last-result
stayed truthful.

**SCHEDULES-GT-13 — held-snapshot safety (17.6) confirmed on the new engine.**
`zfs hold anasrepl <snap>` on the current `anas-daily`, then fired again with
`daily=1`: the held snapshot SURVIVED (surfaced in `skippedHeld`, never handed to
`zfs destroy`), a new snapshot was taken, and both remained — the hold intact
afterward. Our engine excludes held snapshots up front and re-checks `userrefs`
immediately before each destroy, so a replication base is never pruned (contrast
sanoid GT-7, which tries-and-warns; we skip-and-surface).

**SCHEDULES-GT-14 — ZFS periodic-scrub toggle is a clean property round-trip.**
`PUT /v1/scrub/zfs/santest {enabled:false}` → `zfs get org.debian:periodic-scrub`
= `disable`; `{enabled:true}` → `enable`. `GET /v1/scrub` reports each ZFS pool as
`{mechanism:"zfs-property", cadence:"monthly", enabled}` (default-unset reads on).
ANAS never touches the disabled `zfs-scrub-*@.timer`, so no double-schedule (GT-4).

**SCHEDULES-GT-15 — AHR periodic scrub = mdadm's mdcheck timers, NODE-GLOBAL.**
The stunt node ships `mdcheck_start.timer` (`OnCalendar=Sun *-*-1..7 1:00:00`,
`RandomizedDelaySec=24h`, `Persistent=true`) + `mdcheck_continue.timer`, BOTH
`enabled` by default (`WantedBy=mdmonitor.service`, `Also=mdcheck_continue.timer`).
So a stock node with md arrays ALREADY runs a monthly md check (first Sunday) —
the AHR analog of ZFS's monthly cron scrub. `GET /v1/scrub` surfaces the AHR pool
as `{mechanism:"mdcheck-timer", cadence:"monthly", enabled}` with a `note` that the
toggle is node-global (mdcheck verifies every array on the host — no per-pool
granularity). The toggle enables/disables BOTH timers `--now`. Read-only here;
`tank` left `enabled` and untouched.

## Surprises / notes (stage 2)

- **mdcheck is a THIRD timer mechanism**, distinct from ZFS's cron+property and
  the disabled `zfs-scrub-*@.timer`. It is enabled-by-default (unlike the ZFS
  systemd timers), so a fresh md host is already periodically checking — surface
  it, don't add a second schedule.
- **mdcheck has no per-pool knob.** It is the one place the uniform scrub surface
  visibly diverges (parallel-construction: divergence only where tech differs,
  made visible via the state's `note`). Per-pool AHR scrub cadence would need
  ANAS-owned timers — deferred (not v1, per SCHEDULES-DESIGN §Scrub).
- **Identity headers over the socket require a real UUID** for
  `x-anas-request-id` (zod `.uuid()`), and a DELETE must not carry
  `content-type: application/json` with an empty body (Fastify rejects empty JSON
  bodies before the handler) — harness notes, not route bugs.

## 2026-09-25 — a freshly created task's unit firing without a Run now (stunt node)

> Captured on the stunt node (`anas-pve`, 192.168.200.50) at 03:16–03:24 UTC on
> 2026-09-25, against the build deployed from this branch. Two spec runs earlier
> the same day (cloud `pictures-offsite`, backup `gtguard`) had seen a task's
> service start seconds after the task was created, with no `Run now` issued.
> The question: is that `Persistent=true` catching up on a missed calendar
> point, and what decides it. Answer: yes, and the deciding input is the
> **stamp file, which survives deleting the task**.

### What the code does

`packages/daemon/src/services/backup-units.ts` renders every task timer as

```
[Unit]
Description=ANAS backup timer <name>

[Timer]
OnCalendar=<schedule>
Persistent=true

[Install]
WantedBy=timers.target
```

and `writeTaskUnitFiles` in `packages/daemon/src/services/task-units.ts` writes
both unit files, runs `systemctl daemon-reload`, then

```
systemctl enable --now anas-backup-<name>.timer     # enabled task
systemctl disable --now anas-backup-<name>.timer    # disabled task
```

`removeTaskUnits` (same file) does `disable --now`, unlinks the two unit files
and reloads — it does **not** touch `/var/lib/systemd/timers/stamp-…`.
`removeScrubUnits` in `scrub-schedule-units.ts` does delete its stamp (review
R10); the generic task path never got that treatment.

### SCHEDULES-GT-16 — a stamp-less timer does NOT fire on enable

Task `gtsched1`, `OnCalendar=daily`, created 03:17:09 UTC. No stamp file
existed beforehand:

```
--- pre: stamp file for anas-backup-gtsched1.timer ---
ls: cannot access '/var/lib/systemd/timers/stamp-anas-backup-gtsched1.timer': No such file or directory
--- pre: journal for the service ---
-- No entries --
```

Immediately after the create job completed:

```
NEXT                             LEFT LAST                               PASSED UNIT                              ACTIVATES
Sat 2026-09-26 00:00:00 UTC       20h -                                       - anas-backup-gtsched1.timer        anas-backup-gtsched1.service

NextElapseUSecRealtime=Sat 2026-09-26 00:00:00 UTC
LastTriggerUSec=
Persistent=yes
ActiveState=active
InactiveExitTimestamp=Fri 2026-09-25 03:17:09 UTC

-rw-r--r-- 1 root root 0 2026-09-25 03:17:09.707355953 +0000 /var/lib/systemd/timers/stamp-anas-backup-gtsched1.timer
```

45 s later, still nothing (no `Run now` was issued at any point):

```
--- t+45s: journal for the service ---
-- No entries --
--- t+45s: journal for the timer ---
2026-09-25T03:17:09+00:00 anas-pve systemd[1]: Started anas-backup-gtsched1.timer - ANAS backup timer gtsched1.
```

systemd **creates** the stamp file at timer start when it is absent (mtime
03:17:09.707, the moment of `enable --now`) but leaves `LastTriggerUSec` empty,
so the next elapse is computed from *now*: 00:00 tomorrow. There is nothing to
catch up on. The "a `daily` timer enabled at 02:36 sees today's fire as missed"
reading is wrong for a genuinely fresh name.

### SCHEDULES-GT-17 — a LEFTOVER stamp makes it fire immediately

`gtsmoke` is a task an earlier spec run created and deleted. Its stamp file was
still on the node, carrying that run's trigger time:

```
--- pre: stamp file for anas-backup-gtsmoke.timer ---
-rw-r--r-- 1 root root 0 2026-09-24 19:42:14.622373009 +0000 /var/lib/systemd/timers/stamp-anas-backup-gtsmoke.timer
--- pre: unit files ---
ls: cannot access '/etc/systemd/system/anas-backup-gtsmoke.*': No such file or directory
```

A task of that name was created again at 03:18:57 UTC with `OnCalendar=daily`,
and nothing else was asked of it:

```
--- t+0s: systemctl list-timers ---
NEXT                             LEFT LAST                               PASSED UNIT                              ACTIVATES
-                                   - Fri 2026-09-25 03:18:58 UTC     389ms ago anas-backup-gtsmoke.timer         anas-backup-gtsmoke.service
--- t+0s: systemctl show timer ---
NextElapseUSecRealtime=
LastTriggerUSec=Fri 2026-09-25 03:18:58 UTC
Persistent=yes
ActiveState=active
InactiveExitTimestamp=Fri 2026-09-25 03:18:58 UTC
--- t+0s: stamp file ---
-rw-r--r-- 1 root root 0 2026-09-25 03:18:58.344009000 +0000 /var/lib/systemd/timers/stamp-anas-backup-gtsmoke.timer
--- t+0s: service state ---
ExecMainStartTimestamp=Fri 2026-09-25 03:18:58 UTC
ActiveState=activating
SubState=start
InvocationID=c3507a49ff084f5eb2c3057e8c382e15
```

```
--- t+45s: journal for the service ---
2026-09-25T03:18:58+00:00 anas-pve systemd[1]: Starting anas-backup-gtsmoke.service - ANAS backup task gtsmoke...
2026-09-25T03:19:08+00:00 anas-pve node[2040620]: Error: unable to access '/gtbackup/.zfs/snapshot/anas-backup-gtsmoke-1790306338/nosuchpath' - No such file or directory (os error 2)
2026-09-25T03:19:08+00:00 anas-pve systemd[1]: anas-backup-gtsmoke.service: Main process exited, code=exited, status=1/FAILURE
--- t+45s: journal for the timer ---
2026-09-25T03:18:58+00:00 anas-pve systemd[1]: Started anas-backup-gtsmoke.timer - ANAS backup timer gtsmoke.
```

The service started in the same second the timer did. The stamp said "last ran
19:42 yesterday", the last `daily` point (00:00 today) fell after that, so
`Persistent=true` treated it as a missed run and fired.

### SCHEDULES-GT-18 — the stamp file survives deleting the task

`DELETE /v1/backup/tasks/gtsmoke` (job `backup.task.remove`, completed):

```
--- after delete: unit files ---
ls: cannot access '/etc/systemd/system/anas-backup-gtsmoke.*': No such file or directory
--- after delete: stamp file (does it survive?) ---
-rw-r--r-- 1 root root 0 2026-09-25 03:18:58.344009000 +0000 /var/lib/systemd/timers/stamp-anas-backup-gtsmoke.timer
```

The node currently carries 30-odd such orphans, the oldest from 2026-07-19 —
one per task name any spec or operator has ever used and removed.

### SCHEDULES-GT-19 — the same name, the same schedule, the other stamp: no fire

Re-creating `gtsmoke` at 03:20:07 with `OnCalendar=daily` again, the only
difference being the stamp GT-17 had just refreshed to 03:18:58 today:

```
--- t+0s: systemctl list-timers ---
NEXT                             LEFT LAST                               PASSED UNIT                              ACTIVATES
Sat 2026-09-26 00:00:00 UTC       20h Fri 2026-09-25 03:18:58 UTC             - anas-backup-gtsmoke.timer         anas-backup-gtsmoke.service
--- t+0s: systemctl show timer ---
NextElapseUSecRealtime=Sat 2026-09-26 00:00:00 UTC
LastTriggerUSec=Fri 2026-09-25 03:18:58 UTC
Persistent=yes
ActiveState=active
InactiveExitTimestamp=Fri 2026-09-25 03:20:08 UTC
```

and at t+45 s the service journal still ended at the 03:19:08 run — no new
activation. The stamp is the whole variable.

### SCHEDULES-GT-20 — a far-future TIME OF DAY is not immunity

Fresh name `gtsched3`, `OnCalendar=*-*-* 23:59:00`, created 03:21:15, no stamp
beforehand — next elapse 23:59 today, nothing fired:

```
NextElapseUSecRealtime=Fri 2026-09-25 23:59:00 UTC
LastTriggerUSec=
Persistent=yes
--- t+45s: journal for the service ---
-- No entries --
```

The same schedule on a name whose stamp is old (`livemeta`, stamp
2026-07-19 02:13:04) fired at once, because 23:59 *yesterday* is a point the
stamp says was missed:

```
--- t+0s: systemctl list-timers ---
NEXT                             LEFT LAST                               PASSED UNIT                              ACTIVATES
-                                   - Fri 2026-09-25 03:22:09 UTC     457ms ago anas-backup-livemeta.timer        anas-backup-livemeta.service
--- t+0s: systemctl show timer ---
NextElapseUSecRealtime=
LastTriggerUSec=Fri 2026-09-25 03:22:09 UTC
Persistent=yes
--- t+45s: journal for the service ---
2026-09-25T03:22:09+00:00 anas-pve systemd[1]: Starting anas-backup-livemeta.service - ANAS backup task livemeta...
```

### SCHEDULES-GT-21 — an absolute future DATE is immunity

`livetok` (stamp 2026-07-19 02:20:28, two months stale), `OnCalendar=2030-01-01
00:00:00`, created 03:23:04:

```
--- t+0s: systemctl list-timers ---
NEXT                                    LEFT LAST                               PASSED UNIT                              ACTIVATES
Tue 2030-01-01 00:00:00 UTC 3 years 3 months Sun 2026-07-19 02:20:28 UTC             - anas-backup-livetok.timer         anas-backup-livetok.service
--- t+0s: systemctl show timer ---
NextElapseUSecRealtime=Tue 2030-01-01 00:00:00 UTC
LastTriggerUSec=Sun 2026-07-19 02:20:28 UTC
Persistent=yes
ActiveState=active
--- t+45s: journal for the service ---
(empty)
```

A calendar expression with no occurrence between the stamp and now has nothing
to catch up on, however stale the stamp. This is what a spec should use when it
needs an enabled task that will not run itself.

### Verdict

The rule systemd applies on `enable --now` of a `Persistent=true` timer:

- **no stamp file** → the stamp is created with the current time, `LastTrigger`
  stays empty, the next elapse is the first calendar point *after now*. Never an
  immediate run.
- **a stamp file** → its mtime is `LastTrigger`. If any calendar point lies
  between it and now, the timer fires immediately, once.

ANAS creates the condition itself: deleting a task removes its units but leaves
the stamp, so **re-using a task name is what arms the immediate run**, and the
staler the stamp the likelier it is. Both of today's sightings were re-used
names — `pictures-offsite` and `gtguard` are spec task names created and deleted
on every run of their specs.

All five probe tasks were deleted afterwards; no `anas-backup-*`/`anas-cloud-*`
units and no `anas-backup-*` ZFS snapshots remained on the node.

### The two candidate remedies (operator rules)

1. **Write the stamp at creation** — `touch
   /var/lib/systemd/timers/stamp-anas-<kind>-<name>.timer` before `enable
   --now` (or delete it in `removeTaskUnits`, the way `removeScrubUnits`
   already does), so a newly saved task's first run waits for its next real
   calendar point.
2. **Document it** — say plainly that a task whose schedule has already passed
   today runs once as soon as it is saved, and leave the catch-up as the
   missed-run heal it was built to be.

### Remedy (operator ruling 2026-09-25)

Remedy 1, the delete half: `removeTaskUnits` deletes the stamp alongside the
units — the scrub store's pattern (its review R10) — and issues
`systemctl reset-failed` for the service and the timer as TWO calls with their
exits ignored: a removed oneshot that failed otherwise stays behind as a
`not-found` ghost, but the reset itself is NEW here (a one-argv reset-failed
was unproven against real systemd, and the scrub store never issued one until
it gained the same pair — attribution corrected, review R2). The missed-run
heal for a task that still exists is left exactly as systemd built it. The
replication and snapshot-schedule stores — both render `Persistent=true`, both
take re-usable names — got the same removal treatment, and the orphans already
on a node (GT-18 counted 30-odd) are swept at daemon start for ALL the unit
stores' prefixes: every `stamp-anas-backup-*` / `stamp-anas-cloud-*` /
`stamp-anas-repl-*` / `stamp-anas-snap-*` file in the timers dir whose
`.service` unit no longer exists is deleted, one journald line each. A stamp
fresher than the daemon's process start is skipped (a create may be landing in
the sweep's read-then-unlink window); a stamp whose task still exists — its
`.service` file lists in the unit dir, the store's own definition — is the
missed-run heal and stays; a foreign `stamp-*.timer` and the scrub pair are
never touched. The two integration specs keep their GT-21 absolute-date
schedules — the product now removes the stamp itself, so the dates are belt
and braces for pre-fix nodes.

## 2026-09-25 — the remedy, live on the stunt node (`sched.stamps`)

> Captured on the stunt node (`anas-pve`, 192.168.200.50) at 06:02–06:20 UTC on
> 2026-09-25, on the build deployed from this branch. The live proof is
> `tests/integration/sched-stamps.spec.ts` (3 tests, green twice back to back).

### SCHEDULES-GT-22 — the sweep at daemon start, on the node's own orphans

The node carried 26 stamp files before the deploy, 11 of them under our four
prefixes. None had a `.service` unit left — every `anas-repl-*` / `anas-snap-*`
task they belonged to had been deleted by a spec run months or days earlier
(the oldest is GT-18's 2026-07-16):

```
-rw-r--r-- 1 root root 0 2026-09-25 00:00:36.025572000 +0000 stamp-anas-recycle.timer
-rw-r--r-- 1 root root 0 2026-07-16 20:50:19.988477649 +0000 stamp-anas-repl-failproof.timer
-rw-r--r-- 1 root root 0 2026-09-04 02:19:49.609117978 +0000 stamp-anas-repl-lp37nt.timer
-rw-r--r-- 1 root root 0 2026-09-04 02:19:22.097273828 +0000 stamp-anas-repl-lp37ok.timer
-rw-r--r-- 1 root root 0 2026-07-16 20:47:23.275992501 +0000 stamp-anas-repl-proof.timer
-rw-r--r-- 1 root root 0 2026-07-16 22:39:52.065736937 +0000 stamp-anas-repl-remotetask.timer
-rw-r--r-- 1 root root 0 2026-07-16 20:51:10.089472726 +0000 stamp-anas-repl-spec-repl-task.timer
-rw-r--r-- 1 root root 0 2026-07-26 19:59:53.229636504 +0000 stamp-anas-snap-nightly-media.timer
-rw-r--r-- 1 root root 0 2026-07-26 19:44:19.848366542 +0000 stamp-anas-snap-santest-daily.timer
-rw-r--r-- 1 root root 0 2026-09-23 03:19:00.580484329 +0000 stamp-anas-snap-smbsvc-proof-daily.timer
-rw-r--r-- 1 root root 0 2026-09-23 08:10:17.024640000 +0000 stamp-anas-snap-smbsvc-proof-hourly.timer
-rw-r--r-- 1 root root 0 2026-07-27 02:46:55.866476321 +0000 stamp-anas-snap-snaptest-daily.timer
-rw-r--r-- 1 root root 0 2026-09-24 06:38:27.047717000 +0000 stamp-apt-daily-upgrade.timer
…13 more foreign stamps (apt, dpkg, e2scrub, fstrim, logrotate, man-db,
mdcheck ×2, mdmonitor, probe2, proxmox-backup, pve-daily-update, sanoid)
```

The first daemon start carrying the fix journalled one line per orphan and
nothing else — verbatim, `journalctl -u anasd -o short-iso`:

```
2026-09-25T06:04:11+00:00 anas-pve node[2461759]: {"level":30,…,"msg":"task stamp sweep: removed orphan stamp stamp-anas-repl-failproof.timer — its task no longer exists"}
2026-09-25T06:04:11+00:00 anas-pve node[2461759]: {"level":30,…,"msg":"task stamp sweep: removed orphan stamp stamp-anas-repl-lp37nt.timer — its task no longer exists"}
2026-09-25T06:04:11+00:00 anas-pve node[2461759]: {"level":30,…,"msg":"task stamp sweep: removed orphan stamp stamp-anas-repl-lp37ok.timer — its task no longer exists"}
2026-09-25T06:04:11+00:00 anas-pve node[2461759]: {"level":30,…,"msg":"task stamp sweep: removed orphan stamp stamp-anas-repl-proof.timer — its task no longer exists"}
2026-09-25T06:04:11+00:00 anas-pve node[2461759]: {"level":30,…,"msg":"task stamp sweep: removed orphan stamp stamp-anas-repl-remotetask.timer — its task no longer exists"}
2026-09-25T06:04:11+00:00 anas-pve node[2461759]: {"level":30,…,"msg":"task stamp sweep: removed orphan stamp stamp-anas-repl-spec-repl-task.timer — its task no longer exists"}
2026-09-25T06:04:11+00:00 anas-pve node[2461759]: {"level":30,…,"msg":"task stamp sweep: removed orphan stamp stamp-anas-snap-nightly-media.timer — its task no longer exists"}
2026-09-25T06:04:11+00:00 anas-pve node[2461759]: {"level":30,…,"msg":"task stamp sweep: removed orphan stamp stamp-anas-snap-santest-daily.timer — its task no longer exists"}
2026-09-25T06:04:11+00:00 anas-pve node[2461759]: {"level":30,…,"msg":"task stamp sweep: removed orphan stamp stamp-anas-snap-smbsvc-proof-daily.timer — its task no longer exists"}
2026-09-25T06:04:11+00:00 anas-pve node[2461759]: {"level":30,…,"msg":"task stamp sweep: removed orphan stamp stamp-anas-snap-smbsvc-proof-hourly.timer — its task no longer exists"}
2026-09-25T06:04:11+00:00 anas-pve node[2461759]: {"level":30,…,"msg":"task stamp sweep: removed orphan stamp stamp-anas-snap-snaptest-daily.timer — its task no longer exists"}
```

26 files before, 15 after; zero `stamp-anas-{backup,cloud,repl,snap}-*` left,
and every foreign stamp survived — including `stamp-anas-recycle.timer`, which
is ANAS's own (smbsvc recycle) but carries none of the four task prefixes, and
`stamp-probe2.timer` from a ground-truth run of 2026-07-19.

**A node is swept once.** That is why the integration spec PLANTS its orphans
rather than assuming any: one per prefix, backdated (the sweep skips a stamp
newer than the daemon's process start), plus a foreign `stamp-gtsweepforeign`
and a `stamp-anas-scrub.timer` that must both survive. Every restart since
prints exactly four lines:

```
2026-09-25T06:19:11+00:00 anas-pve node[2476761]: {…,"msg":"task stamp sweep: removed orphan stamp stamp-anas-backup-gtsweepbk.timer — its task no longer exists"}
2026-09-25T06:19:11+00:00 anas-pve node[2476761]: {…,"msg":"task stamp sweep: removed orphan stamp stamp-anas-cloud-gtsweepcl.timer — its task no longer exists"}
2026-09-25T06:19:11+00:00 anas-pve node[2476761]: {…,"msg":"task stamp sweep: removed orphan stamp stamp-anas-repl-gtsweeprp.timer — its task no longer exists"}
2026-09-25T06:19:11+00:00 anas-pve node[2476761]: {…,"msg":"task stamp sweep: removed orphan stamp stamp-anas-snap-gtsweepsn.timer — its task no longer exists"}
```

### SCHEDULES-GT-23 — the `reset-failed` pair, before and after

A task whose last run FAILED is a `failed` unit until something resets it, and
a task deleted in that state used to stay listed as a `not-found` ghost. The
spec runs each task to a real failure first (a backup on an archive path that
does not exist; a cloud sync whose source is the fixture's never-mounted CIFS
line), then deletes it. `systemctl list-units --failed --no-legend` either
side of the `DELETE`:

```
--- backup, BEFORE the delete ---
● anas-backup-gtstampbk.service loaded failed failed ANAS backup task gtstampbk
● nmbd.service                  loaded failed failed Samba NMB Daemon
● zfs-import@datapool.service   loaded failed failed Import ZFS pool datapool
● zfs-share.service             loaded failed failed ZFS file system shares
--- backup, AFTER the delete ---
● nmbd.service                loaded failed failed Samba NMB Daemon
● zfs-import@datapool.service loaded failed failed Import ZFS pool datapool
● zfs-share.service           loaded failed failed ZFS file system shares
```

```
--- cloud, BEFORE the delete ---
● anas-cloud-gtstampcl.service loaded failed failed ANAS cloud sync task gtstampcl
● nmbd.service                 loaded failed failed Samba NMB Daemon
● zfs-import@datapool.service  loaded failed failed Import ZFS pool datapool
● zfs-share.service            loaded failed failed ZFS file system shares
```
```
--- cloud, AFTER the delete ---
● nmbd.service                loaded failed failed Samba NMB Daemon
● zfs-import@datapool.service loaded failed failed Import ZFS pool datapool
● zfs-share.service           loaded failed failed ZFS file system shares
```

The three surviving entries are the node's own long-standing failures and are
untouched. The removal also deletes the stamp, so the SAME name re-created
immediately afterwards with `OnCalendar=*-*-* 00:05:00` — a time of day that
passed hours ago — records `LastTriggerUSec=` (empty), starts no service in 45
seconds of journal, and reports no `lastRunAt`. That is the GT-17 self-fire,
gone.
