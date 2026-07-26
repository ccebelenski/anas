# Schedules — uniform ANAS-owned snapshot scheduling (+ scrub surfacing)

**Status:** designed 2026-07-26. **Supersedes the 17.1 `sanoid` tool pick.** That decision was made for ZFS before the operator required schedules **uniform across AHR and ZFS**; `sanoid` is ZFS-only, so it cannot deliver uniformity. We keep the *learning* from sanoid (its retention model, captured in docs/SCHEDULES-GROUND-TRUTH.md) and manage the schedule ourselves.

## Guiding principle (operator, 2026-07-26)
**ZFS and AHR function EXACTLY THE SAME with respect to snapshots, scrubbing, and pruning — one uniform user experience — even though the underlying mechanisms differ.** The operator schedules/toggles/prunes a ZFS dataset and an AHR pool through identical controls; ANAS dispatches to the filesystem-appropriate backend behind that uniform surface. (This is [[feedback-parallel-construction]] applied end to end.) Dropping sanoid also removes an external dependency — more guest-faithful (we don't bend the system around a third-party tool's config + timers).

## Decisions
- **No sanoid.** Nothing sanoid does that we'd use is irreplaceable: its keep-N-per-period retention is a simple algorithm (we replicate it, using sanoid's proven bucketing as the reference); its extras (Nagios `--monitor`, `syncoid`) we don't use; its hold-handling is *worse* than detecting+skipping holds; and it's ZFS-only. The 17.2 `sanoid.conf` parser is now dead product code — remove it during the build (the ground-truth learning carries forward, the parser doesn't).
- **Mechanism: systemd timers** (not cron). `Persistent=true` catches runs missed during downtime (a NAS reboots; a snapshot scheduled while off fires on next boot — cron can't); journald observability; matches the replication task-store's systemd-unit pattern (Epic 5.5). ANAS authors one templated timer+service per schedule (surgical, guest philosophy).
- **Scope:** ANAS-managed pools/datasets only. PVE-managed pools stay hands-off / display-only (3.25).

## Uniform snapshot model (AHR btrfs AND ZFS — one policy, one screen, one mechanism)
A **snapshot schedule** = `{ target, cadence, retention, recursive? }` where target is a ZFS dataset or an AHR pool. On timer fire ANAS runs the filesystem-appropriate command behind one uniform policy:

| | Take | Prune (over-retention) | Hold-safety |
|---|---|---|---|
| **ZFS** | `zfs snapshot [-r] <ds>@anas-<bucket>-<utc>` | `zfs destroy` the excess | SKIP `userrefs>0` (held, e.g. a replication base); surface as "retained (held)" — never a failed-destroy |
| **AHR** | ro btrfs snapshot `@data → @snapshots/anas-<bucket>-<utc>` (reuse 11.12 primitives) | `btrfs subvolume delete` the excess | n/a (btrfs snapshots aren't ZFS-held; AHR replication is separate) |

- **Naming convention** (`anas-<bucket>-<utc>`) marks ANAS-scheduled snapshots; pruning touches ONLY those — never replication bases, manual snapshots, or AHR-manual snapshots (mirrors sanoid pruning only its own).
- Three snapshot lifecycles stay independent and coexist: **scheduled** (this feature), **replication** (Epic 5.5), **AHR-manual** (11.12). The dataset/pool view shows the inventory of all three; Schedules owns only the scheduled policy.

## Retention (learned from sanoid, GT §)
Buckets `frequently / hourly / daily / weekly / monthly / yearly`, keep N of each; **always keep the most recent**; assign each snapshot to its bucket by age and keep the N newest per period. Encode sanoid's proven bucketing so we inherit its edge-case correctness rather than reinventing it. UI: a few **presets** ("24h/30d/12m", "minimal", "aggressive") + an **advanced** expander for raw per-bucket counts (operator's common-case-first instinct).

## Scrub — uniform UX, filesystem-native backend
Scrub follows the same principle: the operator enables/disables/schedules a **periodic scrub** on a ZFS pool and an AHR pool through **identical controls**; the backend differs.
- **ZFS backend:** PVE already monthly-scrubs via `/etc/cron.d/zfsutils-linux`, per-pool-gated by the `org.debian:periodic-scrub` property. ANAS surfaces + toggles that property — same mechanism as PVE, no double-schedule.
- **AHR (md) backend:** md's own `mdcheck_start`/`mdcheck_continue` timers (installed with mdadm) are the native periodic-check scheduler — surface + toggle those; the AHR Scrub *verb* (11.x) remains the on-demand path.
- **Uniform surface:** the Schedules screen shows "periodic scrub: on/off (monthly)" identically for both; enabling/disabling flips the right backend. (Custom cadence beyond the native monthly is a later refinement — if needed, ANAS-owned scrub timers for both, kept uniform; not v1.)

## Store + Schedules screen (17.3)
- **Schedule store:** the replication task-store pattern — the systemd timer/service unit is the source of truth (+ a small ANAS-owned descriptor); node-local (schedules for node-local datasets).
- **Screen:** one grid over snapshot schedules (both fs types, uniform) and scrub schedules (surfaced from the native mechanisms, overlap flagged); create/edit/disable/delete a snapshot schedule with the retention policy; held snapshots shown as intentionally-retained; overdue/failed on the dashboard (17.7, matching the replication policy).

## Epic 17 story impact
- **17.1** stays done (ground truth valid; the *tool decision* within it is superseded here — sanoid → ANAS-owned).
- **17.2** (sanoid.conf parser) — superseded; parser removed during the build; the retention-semantics learning is folded into the ANAS retention engine.
- **17.3–17.7** re-based onto this uniform ANAS-owned mechanism (schedule store + systemd timers + retention engine + per-fs take/prune + scrub surfacing + dashboard).
