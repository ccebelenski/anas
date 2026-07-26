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
