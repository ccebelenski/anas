# AHR — Stunt-Node Ground Truth (Stage 0)

> Captured 2026-07-22 on the stunt node (PVE 9.2.4, kernel 7.0.14-5-pve, mdadm 4.4,
> LVM 2.03.31, btrfs-progs 6.14). Scaled 2/3/4 TB worked example at 1:2048
> (1024/1536/2048 MiB virtual disks). The full stack was BUILT, EXPANDED online,
> failure-drilled, and rebooted; a sha256 manifest of test data verified intact after
> every phase. Raw logs in the session scratchpad; the durable facts are below.
> Design corrections have been folded into docs/AHR-DESIGN.md.

## What was proven end-to-end

1. **Fresh build** (§2.1 layout): 3 mismatched disks → banded GPT partitions → md
   (RAID5×3 + RAID1×2) → LVM concat VG/LV → btrfs `-d single -m dup` → mounted,
   loaded with data + sha256 manifest.
2. **Online expansion #1** (add 4th disk): all three planner moves in one pass —
   `array-grow` (RAID5 3→4), `array-convert` (RAID1×2 → RAID5×3, **one-shot**
   `mdadm --grow --level=5 --raid-devices=3` works), `array-create` (new top band),
   then pvresize/pvcreate → vgextend → lvextend → btrfs resize max. **Filesystem
   mounted and readable throughout.** Checksums OK.
3. **Failure gauntlet**: member failed mid-reshape (throttled) → `clean, degraded,
   reshaping` (md continues); then hard power-off (virsh destroy) on top → recovery
   per the ladder below → reshape resumed from checkpoint, completed degraded →
   failed disk re-added, rebuilt → clean. Checksums OK at every stop.
4. **Live replace**: `--replace --with` copies while the array stays
   `clean, recovering` — **no degraded window**. Checksums OK.
5. **Marginal-too-small member**: clean refusal, exit 1, message
   `not large enough to join array` — perfect for the §2.5 pre-check to surface.
6. **Clean reboot**: arrays auto-assemble, VG auto-activates, no fstab → not mounted
   (Epic 18 machinery is the answer). Checksums OK.

## Facts the code must honor (numbered for reference)

**GT-1 — PVE 9 ships neither `mdadm` nor `btrfs-progs`.** The installer must add
them (Debian packages; mdadm install pulls in mdmonitor units — see GT-11).

**GT-2 — Kernel device names are garbage.** `sdX` scrambles across hotplugs;
kernel `mdNNN` numbers reshuffle across operations AND reboots (r1 was md127, r2
md126, r3 md125 — order inverted from creation). Only by-id disk paths and md
UUIDs/superblock names are stable.

**GT-3 — `/dev/md/<name>` symlink is NOT stable either.** After hotplug assembly it
was `/dev/md/ahr0-r2`; after clean boot it was `/dev/md/anas-pve:ahr0-r1`
(homehost-prefixed). Resolve arrays via `mdadm --detail --export` (KEY=VALUE,
structured: MD_NAME, MD_UUID, MD_LEVEL, MD_DEVICES, per-member entries) and match on
name/UUID. Alternatively pin names with ARRAY lines in `/etc/mdadm/mdadm.conf`
(surgical edit — decide at build; parsing must tolerate both forms regardless).

**GT-4 — GPT eats the edges; sgdisk end positions are INCLUSIVE.** Partition 1
starts at 1 MiB; the backup GPT consumes the last 33 sectors, so a band boundary at
the disk's nominal end must clamp to last-usable. An interior partition ending "at"
boundary B overlaps the next partition by one sector unless end = B−1 (or `+size`
notation). The partitioner computes: interior slices `[B_{i-1}, B_i)` as
start=B_{i-1}, size=B_i−B_{i-1}; each disk's topmost slice runs to last-usable.

**GT-5 — md default data offset VARIES with member size** (2048 sectors on the
1 GiB members, 4096 on others here; 128 MiB typical on TB-scale disks). ANAS pins
`--data-offset` explicitly at creation for determinism and reshape headroom.
Calibrate the production value on TB-scale disks (offset also bounds unused-space
headroom for future grows).

**GT-6 — Backup-file-free grows CONFIRMED.** RAID5 3→4 grow proceeded with no
`--backup-file`, via data-offset shift: the NEW member joined with data offset 1024
vs the originals' 2048. Consequences: (a) §5.1's mandate is achievable even at
small offsets, (b) **per-member data offsets differ within one array — parsers must
not assume uniformity**, (c) repeated grows shrink offsets — another reason for
GT-5's generous explicit offset.

**GT-7 — RAID1→RAID5 convert is one-shot**: `--add` the new member (comes in as
spare), then `mdadm --grow --level=5 --raid-devices=3`. Passes through a transient
2-disk-RAID5 internally; treat level+count as one `array-convert` step.

**GT-8 — THE BIG ONE: after power loss during a DEGRADED reshape, the array
assembles INACTIVE** — all members listed as spares `(S)`, array not running; udev
incremental assembly is conservative. (Healthy arrays assembled fine in the same
boot.) The design's old claim "md resumes automatically on assembly" is WRONG for
this case. Recovery ladder, gentlest first, each step verified:
  1. `mdadm --run <array>` → array starts, correctly drops the failed member,
     comes up `active (auto-read-only), clean, degraded`, reshape parked.
  2. `mdadm --readwrite <array>` (or first write) → reshape resumes **from its
     checkpoint** and completes.
  3. LVM: `vgchange -ay` after the PV appears; mount; data intact.
ANAS boot-time detection must recognize the inactive-all-spares state and drive
this ladder — monitoring alone is not enough.

**GT-9 — `auto-read-only` is the NORMAL post-assembly state** (every array, every
boot, until first write). Health views must not flag it as a fault.

**GT-10 — Reshape throttling works as designed (§9 Q4 answered).**
`dev.raid.speed_limit_max` (sysctl) throttles reshape/rebuild immediately in both
directions; 500 KB/s crawled, 200 MB/s released. ANAS can offer a throttle during
expansions; kernel default restored after.

**GT-11 — mdmonitor runs OUT OF THE BOX (§9 Q6 answered).** Installing mdadm
activates `mdmonitor.service` (MAILADDR root) plus `mdmonitor-oneshot.timer`
("Reminder for degraded MD arrays"). Events (Fail, RebuildFinished, DegradedArray,
…) already fire; root mail goes nowhere useful on a stock PVE node. Cleanest
leverage candidate: set `PROGRAM` in mdadm.conf (surgical edit) to a small ANAS
hook that forwards to PVE's notification system — evaluate against polling at build.

**GT-12 — Live-hotplugged disks carrying STALE ZFS labels wedged the guest**
(ZED/zpool scan hung in a ZFS ioctl after the disks vanished; guest needed a hard
reset). Two lessons: create-time `wipefs`/`--zap-all` of prior signatures is
mandatory (already designed), and the disk picker's in-use/foreign-label exclusions
are safety-critical, not cosmetic.

**GT-13 — Structured output inventory** (all confirmed parseable): `mdadm --detail
--export` (KEY=VALUE), `/proc/mdstat` (only for sync/reshape percent+speed+ETA —
no structured alternative exists), `pvs/vgs/lvs --reportformat json`, `lsblk -J -b`,
`btrfs filesystem usage -b`, `sgdisk -p` (last resort; prefer lsblk JSON).

**GT-14 — Real capacity vs band math**: measured ~0.4% under nominal at this scale
(per-member ≈2 MiB md overhead + GPT edges + LVM extent rounding + btrfs dup
metadata). §2.2's softened claim stands; the §2.5 GiB-floor rounding absorbs all of
this at production scale except btrfs metadata, which `btrfs filesystem usage`
reports live (never precompute free space — read it).

**GT-15 — AHR-2 (RAID6) command path PROVEN** (same-day follow-up): create ×4,
backup-file-free grow ×4→×5 (offset-shift, same as RAID5), double member failure →
`clean, degraded`, data checksum intact. All planner moves are level-generic as
hoped.

**GT-16 — Real-fleet disk-size variance is ZERO within a nominal class (§9 Q2
closed).** Operator capture 2026-07-22, 43 data disks across pve5/pve10/pve14,
8 vendor/model families: every disk of a given nominal size is byte-identical —
including cross-vendor (Seagate ST14000NM005G ≡ WDC WD140EFGX at
14000519643136) and cross-interface (Samsung SAS ≡ Intel SATA at
3840755982336). LBA counts are standardized per class; the "tens of MB
variance" folklore does not apply to modern drives. The REAL trap is
**marketing-class mismatch**: "1 TB" SSDs split into a 1024-GB class
(1024209543168 — Kingston/SPCC/Gigastone) and a 1000-GB class (1000204886016 —
Crucial), 24 GB apart — no reserve should try to absorb that; the §2.5
pre-check rejects it with a clear class-mismatch message. Floor-to-GiB stands:
generous insurance at ≤0.005% cost on a 20 TB disk.
Fleet bonus datapoint: pve14 `sdi` is a 20 TB drive partitioned down to 18 TB
to serve in an 18 TB ZFS vdev — 2 TB stranded. The exact pain AHR removes,
observed in production.

**GT-17 — PVE notification SEND mechanism proven (closes the 9.4/9.5 "how" question).**
`PVE::Notify::{info,notice,warning,error}(template_name, template_data, fields)`
(Perl, /usr/share/perl5/PVE/Notify.pm) renders handlebars templates from
`/usr/share/pve-manager/templates/default/<name>-{subject,body}.txt.hbs` and routes
through the operator's configured matchers/targets (Gotify/email — whatever they
already set up; ANAS emits, PVE delivers). Verified live on the stunt node: ANAS
templates `anas-ahr-*.hbs` dropped in, send succeeded end-to-end up to delivery
(only failure: stunt node's mail-to-root has no recipient — expected on a bare
node). Template files live in pve-manager's dir → a pve-manager upgrade can wipe
them → reinstall via the existing DPkg::Post-Invoke apt-hook pattern (same as the
index.html.tpl handling). The `fields` param carries matcher-filterable metadata
(e.g. `type=anas-ahr`) so operators can route ANAS events specifically.

## Timing observations (scale-dependent, directional only)

- Initial RAID5 sync and small reshapes: bounded by `speed_limit_max` when
  throttled; at defaults on virtio, effectively disk-speed. On real TB-scale
  arrays reshape is hours-days → the §6.3 duration estimate must derive from
  measured `speed` in `/proc/mdstat`, not precomputed constants.
- `--replace` copy runs at rebuild speed but WITHOUT redundancy loss — always
  prefer it when the outgoing disk is alive (§5.1, confirmed).

## Still open after stage 0

- **Production data-offset value (GT-5)**: calibrate on TB-scale disks.
- **mdadm.conf ARRAY pinning vs tolerate-both (GT-3)**: decide at build.
