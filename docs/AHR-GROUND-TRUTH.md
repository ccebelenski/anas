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
headroom for future grows). **CLOSED 2026-07-24** — see the calibration below.

**GT-5 CALIBRATION (2026-07-24, stunt node, mdadm 4.4, sparse files + loop
devices, RAID5 `--assume-clean --bitmap=internal`, NO `--data-offset`):**

*Native default offset vs member size* (mdadm's own choice; one member examined):

| Member size | Native Data Offset | = MiB | Unused before / after |
|-------------|--------------------|-------|-----------------------|
| 64 GiB      | 133120 s           | 65    | 133040 s / 0          |
| 256 GiB     | 264192 s           | 129   | 264112 s / 0          |
| 512 GiB     | 264192 s           | 129   | 264112 s / 0          |
| 1 TiB       | 264192 s           | 129   | 264112 s / 0          |
| 4 TiB       | 264192 s           | 129   | 264112 s / 0          |
| 8 TiB       | 264192 s           | 129   | 264112 s / 0          |
| 15.6 TiB    | 264192 s           | 129   | 264104 s / 0          |
| 4 TiB RAID6 | 264192 s           | 129   | 264112 s / 0          |

Chunk 512K, internal bitmap 8 s from superblock, throughout. The native offset
**plateaus at 264192 s (129 MiB) for every member ≥ 128 GiB** and is constant
across a 60× size range (256 GiB → 15.6 TiB), RAID5 and RAID6 alike. mdadm's
headroom algorithm caps at 128 MiB and only halves *below* the 128 GiB knee
(64 GiB → 65 MiB), so 20 TiB is 129 MiB too — the literal 20 TiB reading was
blocked only by ext4's 16 TiB max-file-size ceiling on the scratch fs, not by any
change in mdadm's choice. **The old 128 MiB pin therefore sat 1 MiB UNDER mdadm's
own default — stingier than the value it replaced.**

*Offset consumed per backup-file-free grow* (4-member RAID5 pinned at 8192 s /
4 MiB, `mdadm --wait` between each grow, all grows offset-shift, NO backup file):

| Members | Data Offset (all members, uniform) | Consumed by this grow |
|---------|-----------------------------------|-----------------------|
| 4 (create) | 8192 s (4 MiB)                | —                     |
| 5          | 4096 s (2 MiB)                | 4096 s (2 MiB)        |
| 6          | 4096 s (2 MiB)                | 0                     |
| 7          | 4096 s (2 MiB)                | 0                     |

Consumption is **NOT cumulative-linear**: the first grow made a single bounded
~2 MiB shift (a chunk-scaled critical-section reservation), then the offset held
flat across the next two grows. GT-6's "repeated grows shrink offsets" was an
over-generalization from a tiny 2048 s start; at any sane pinned offset the shift
is one-time and small. Offsets stayed **uniform** across members here (contrast
GT-6's divergence at 2048 s) — parsers must still not assume uniformity, but the
budget math does not depend on per-grow accumulation.

*Policy decision (landed in `ahr-geometry.ts`):* pin a **generous round offset
≥ mdadm's native**. Members ≥ 128 GiB (all production TB-scale disks; mdadm's own
plateau knee) → **256 MiB (524288 s)**: dominates native 129 MiB with margin,
clean power-of-two, funds effectively unlimited grows (shift floors ~2 MiB), waste
0.00128 % on a 20 TB disk. Members < 128 GiB (small/test, e.g. the 2 GiB stunt
pool) → **4 MiB (8192 s)**, unchanged — proven backup-file-free and affordable on
tiny members. **Applies to newly created arrays only**; existing pools (stunt
`tank`, any operator pool) keep the offset they were minted with (on-disk,
immutable), and that offset is their permanent reshape budget.

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

- ~~**Production data-offset value (GT-5)**~~: **CLOSED 2026-07-24** — calibrated
  (see GT-5 above); pin is 256 MiB for members ≥ 128 GiB, 4 MiB below.
- **mdadm.conf ARRAY pinning vs tolerate-both (GT-3)**: decide at build.

## 18. Read cache — live cache failure and slice publishing (2026-09-24)

> Captured on the stunt node (PVE 9.2.20, kernel 7.0.14-17-pve, lvm2
> 2.03.31-2+pmx1, ANAS 0.3.5 build installed). Answers the two "Open before
> dispatch" items of AHR-DESIGN §13 (read cache — lvmcache writethrough,
> GitHub #63) ahead of the ahrcache.1 dispatch. Real virtual disks, not loop
> devices. No product code was changed; this is measurement only.

**The bed.** AHR-1 pool `gtcache` on two 1 GiB disks (`ANAS_HOT7`/`ANAS_HOT8`),
created through the daemon's own API (`POST /v1/ahr`, confirm-code flow, job to
completion — never by hand), `@data`/`@snapshots` layout, mounted at
`/mnt/anas-ahr/gtcache`. Loaded with 256 × 1 MiB random files plus a sha256
manifest. Cache SSD stand-in = one 512 MiB GPT slice on a third 2 GiB disk
(`ANAS_HOT9`), attached by hand exactly as §13 specifies:

```
# sgdisk -n 1:1M:+512M -t 1:8E00 -c 1:gtcache-cache1 \
      /dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9
# wipefs -a  /dev/disk/by-id/…ANAS_HOT9-part1
# pvcreate   /dev/disk/by-id/…ANAS_HOT9-part1
# vgextend gtcache /dev/disk/by-id/…ANAS_HOT9-part1
# lvcreate -n gtcache-cache -l 100%PVS gtcache /dev/disk/by-id/…ANAS_HOT9-part1
# lvconvert -y --type cache --cachevol gtcache-cache --cachemode writethrough \
      gtcache/gtcache-vol
  Logical volume gtcache/gtcache-vol is now cached.
```

**GT-18 — Cache attach AND detach are live operations on a mounted pool.**
`lvconvert --type cache` ran with the pool mounted and in use; the filesystem
never blinked, and `/dev/mapper/gtcache-gtcache--vol` kept both its name and
its dm number (252:0 → `dm-0`) across attach, failure and detach. Mounts,
shares, LUNs and the fstab line are genuinely untouched, as §13 assumes. Two
mechanical notes for the step: `lvconvert` needs `-y` to run non-interactively,
and `pvcreate` **refuses** non-interactively when the slice carries a stale
foreign signature — on a recycled disk it printed

```
WARNING: zfs_member signature detected on …ANAS_HOT9-part1 at offset 16384. Wipe it? [y/n]: [n]
  Aborted wiping of zfs_member.
  1 existing signature left on the device.
```

and then `vgextend` failed with `Physical Volume "…" not found in Volume Group
"gtcache"`. The `cache-attach` step must `wipefs -a` the slice before
`pvcreate`, the same way `ahr-create` wipes a member disk.

After warming (eight full read passes over the 256 MiB set, page cache dropped
each pass) the cache was live and hot: `cache_used_blocks` 3870/8000 (64 KiB
blocks ≈ 241 MiB), `cache_read_hits` climbing ~3 900 per pass,
`cache_dirty_blocks` 0 — zero by construction in writethrough, as designed.

### (a) The cache device failing under a LIVE pool

Cache slice made to fail by detaching its virtual disk live (`remove-disk.sh 9`)
while a direct-I/O reader loop ran against the pool.

```
2026-09-24T19:32:00 pass=14 file=f15.bin rc=0 | 1048576 bytes … 132 MB/s
2026-09-24T19:32:01 pass=15 file=f16.bin rc=1 | dd: error reading '…/f16.bin': Input/output error
2026-09-24T19:32:02 pass=16 file=f17.bin rc=1 | dd: error reading '…/f17.bin': Input/output error
…
```

**GT-19 — dm-cache does NOT bypass a dead cache device: reads fail fast with
EIO, they do not hang, and they do not fall through to the origin.** The
failure was immediate (same second as the detach) and total — files that had
never been promoted failed identically to cached ones, and a raw read of the LV
itself failed:

```
# dd if=/dev/mapper/gtcache-gtcache--vol of=/dev/null bs=4k count=1 iflag=direct
dd: error reading '/dev/mapper/gtcache-gtcache--vol': Input/output error
```

The detection signal is clean and structured enough to poll:

```
# dmsetup status
gtcache-gtcache--vol: 0 2080768 cache Error
# pvs
  WARNING: Couldn't find device with uuid 18IiiM-….
  WARNING: VG gtcache is missing PV 18IiiM-… (last written to /dev/sdd1).
  PV         VG      Fmt  Attr PSize    PFree
  /dev/md127 gtcache lvm2 a--  1016.00m    0
  [unknown]  gtcache lvm2 a-m   508.00m    0
```

`dmsetup status` reports the cache target as a single token; `lvs`,
`pvs` and `vgs` mark the partial VG (`Cwi-aoC-p-`, `wz-pn-`, PV attr `a-m`) and
name the missing PV UUID on stderr. **The cache counters in `lvs` go stale
rather than absent** — they keep reporting the last values read before the
metadata died (3881 used blocks, 25 632 hits), so the pool-detail `cache` block
must not present them as live once the target stops reporting a status line.

> **Refined 2026-09-24 during the ahrcache.1 slice-1 build** (same node, kernel
> 7.0.14-17-pve). Two corrections to the shape above, both measured:
> 1. **The failure word is not one word.** Pulling the cache device under a
>    pure READ load gives `0 2080768 cache Fail`, not `Error` — dm-cache emits
>    `Fail` for a cache in `CM_FAIL` and `Error` from the generic target-error
>    path, and the capture above was taken after a write had aborted the
>    metadata transaction. A token list would have been one kernel wording away
>    from calling a dead cache healthy, so the shipped test is structural: a
>    real dm-cache status line opens with the metadata block size, a DIGIT;
>    anything else is a failure word, whatever this kernel calls it.
> 2. **`dmsetup status <name>` does NOT repeat the name.** The bare
>    `dmsetup status` listing prefixes each line with `<name>: `, but the
>    single-device form — the one a per-pool health read uses — prints the
>    target line alone (`0 2080768 cache Fail`). The parser handles both.
>
> Also measured on the same pass: in that instance `lvs` reported the counters
> as ZEROES (`cache_total_blocks: 0`, hits 0) rather than stale values. Either
> way `lvs` cannot tell a working cache from a dead one, which is the fact the
> gate exists for. Verbatim captures of all of it are committed as
> `fixtures/ahr/dmsetup-status-cache-{healthy,failed}.txt`,
> `dmsetup-status-uncached.txt`, `lvm-pvs-cach{ed,e-missing}.json` and
> `lvs-cach{ed-live,e-missing}.json`.

**btrfs behaviour splits by workload, and this is the part that decides the
recovery rung.** Under a pure *read* load the filesystem stayed **rw** and just
counted errors — `btrfs device stats` read_io_errs climbing, `BTRFS error
(device dm-0): bdev … errs: wr 0, rd 28, flush 0, corrupt 0, gen 0`. The first
*write* took it down:

```
[360961.968586] device-mapper: cache: 252:0: aborting current metadata transaction
[360961.988273] device-mapper: cache: 252:0: failed to abort metadata transaction
[360976.264789] BTRFS info (device dm-0 state E): forced readonly
[360976.264791] BTRFS warning (device dm-0 state E): Skipping commit of aborted transaction.
[360976.264793] BTRFS error (device dm-0 state EA): Transaction aborted (error -5)
```

**GT-20 — `lvconvert --uncache` is the whole recovery, it works with the device
absent and the pool mounted, and it takes under a third of a second.** No
`--force`, no unmount, no prior `vgreduce`:

```
# lvconvert --uncache gtcache/gtcache-vol
  WARNING: VG gtcache is missing PV yqLyG2-… (last written to /dev/sdd1).
  WARNING: Skipping flush for failed cache gtcache/gtcache-vol.
  Logical volume "gtcache-cache" successfully removed.
  Logical volume gtcache/gtcache-vol is not cached and gtcache/gtcache-cache is removed.
real  0m0.224s          (0m0.289s on the first run; 0m0.247s on a healthy detach)
```

The "Skipping flush" warning is the writethrough guarantee doing its job — there
is nothing to flush. **Service resumes in the same second, with no unmount at
all** — the reader loop recovered on the pass immediately after the uncache
completed:

```
2026-09-24T19:33:21 pass=94 file=f95.bin rc=1 | dd: error reading …: Input/output error
2026-09-24T19:33:22 pass=95 file=f96.bin rc=0 | 16+0 records in
2026-09-24T19:33:23 pass=96 file=f97.bin rc=0 | 16+0 records in
```

`dmsetup status` becomes `gtcache-gtcache--vol: 0 2080768 linear`, the LV keeps
its name and mapper path, and `vgreduce --removemissing gtcache` (0.07 s) then
drops the ghost PV and writes out a consistent VG. **All 256 files verified
against the sha256 manifest, byte-identical, after every cycle** — cache loss,
uncache, `vgreduce`, and again after a clean detach.

**The one thing `--uncache` cannot undo is the btrfs forced-readonly flag.**
When a write had already aborted the transaction, the pool came back
read-only-but-readable, and a remount was refused:

```
# mount -o remount,rw /mnt/anas-ahr/gtcache
mount: /mnt/anas-ahr/gtcache: mount point not mounted or bad option.
[361032.761003] BTRFS error (device dm-0 state EMA): remounting read-write after error is not allowed
```

`umount` + `mount` restored rw cleanly and reset `btrfs device stats` to zero.

**Conclusion (a):** the daemon should uncache automatically on detection —
`--uncache` is fast, needs no force, needs no unmount, has nothing to flush in
writethrough, and restores read service instantly, so leaving the pool in
all-I/O-fails while a human finds a button is strictly worse. Restoring *write*
service is the part that cannot be automatic in the same breath: if the pool
took a write during the failure window it is btrfs-forced-readonly and needs
umount+mount, which is a remount of a live share — that is the piece that
belongs behind an operator action, with the notification saying so.

### (b) Slice publishing

**GT-21 — A cache slice on an idle disk publishes immediately; the issue-#12
retry dance is not needed, but `udevadm settle` still is.** On a freshly wiped,
unheld disk, `sgdisk` succeeded silently and the kernel node appeared at once
(`dmesg`: ` sdd: sdd1`), while the by-id symlink and `PARTLABEL` needed the
settle — the same shape as the CREATE path:

```
# sgdisk -n 1:1M:+512M -t 1:8E00 -c 1:gtcache-cache1 /dev/disk/by-id/…ANAS_HOT9
Creating new GPT entries in memory.
The operation has completed successfully.
# lsblk                    ← immediately, no settle, no partx
NAME    SIZE TYPE PARTLABEL
sdd       2G disk
└─sdd1  512M part                       ← kernel node present, udev not done yet
# udevadm settle
# lsblk; ls /dev/disk/by-id/…HOT9*
└─sdd1  512M part gtcache-cache1
…ANAS_HOT9-part1 -> ../../sdd1
```

The negative confirms the mechanism is holders, not luck. Partitioning the same
disk once its slice 1 was an in-use cache PV:

```
# sgdisk -n 2:514M:+512M -t 2:8E00 -c 2:gtcache-cache2 /dev/disk/by-id/…ANAS_HOT9
Warning: The kernel is still using the old partition table.
The new table will be used at the next reboot or after you
run partprobe(8) or kpartx(8)
The operation has completed successfully.          ← exit 0, and the node never appears
# blockdev --rereadpt /dev/sdd
blockdev: ioctl error on BLKRRPART: Device or resource busy
# partx -a /dev/sdd
partx: /dev/sdd: error adding partition 1          ← expected, part 1 already known
# ls /dev/disk/by-id/ | grep HOT9
…ANAS_HOT9
…ANAS_HOT9-part1
…ANAS_HOT9-part2                                   ← partx published part 2
```

`sgdisk` exits **0** while silently not publishing — the exact trap issue #12
documented — and `udevadm settle` does not help, because no event was
generated. Also noted: **`partprobe` is not installed on PVE 9**
(`bash: partprobe: command not found`), so the warning text names a tool the
node does not have; `partx -a` is the remedy that is actually present.

**GT-22 — `pvremove` + `wipefs` are not enough to hand the cache disk back.**
With the slice wiped but still in the GPT, `GET /v1/disks` reports the disk
`other` (a partition with no filesystem is still a partition):

```
scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9 status= other parts= [('sdd1', None)]
```

After the slice is deleted from the table (`sgdisk -d 1`, or `--zap-all`), the
same call reports:

```
scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9 status= available parts= []
```

The `cache-detach` step therefore ends at *remove the partition*, not at
*wipe it* — otherwise the SSD never becomes selectable again.

**Conclusion (b):** a cache slice needs no `partx` treatment — the cache disk is
idle by definition at attach time, so `sgdisk` + `udevadm settle` (the create
path's pair) is correct and sufficient; a second slice on an already-attached
cache disk would need the expansion path's partx-then-verify, which is one more
reason to keep one slice per cache disk. Detach must delete the slice.

### What today's daemon sees (pre-ahrcache.1 baseline)

**GT-23 — With the cache dead and the pool unable to serve a single byte, ANAS
reports the pool `healthy`.** Captured live, while every read was returning
EIO:

```
GET /v1/ahr/gtcache  → state: healthy | mounted: True | advisories: []
                        arrays: [(1, 'clean')]
GET /v1/status       → ahrPools: [{"name":"gtcache","state":"healthy","mounted":true,…}]
                        warnings: (nothing about gtcache)
```

Nothing in the product mentions the cache at all — not its absence, not its
presence. (To its credit the daemon does not *break*: the LVM stderr warnings on
a partial VG parse through without a 500.) The detection rung ahrcache.1 plans
is therefore load-bearing, not a nicety.

Two smaller mis-readings, with the cache attached and healthy:

- `GET /v1/disks` reports the cache disk `status: "other"`, `poolName: null`,
  `ahrArray: null` — it is not attributed to the pool it serves. This is
  accidentally safe (`isComposableDisk()` admits only `available`, so the disk
  is already excluded from composer, spare and expand candidates) but it reads
  in the UI as an unrelated foreign disk.
- `GET /v1/ahr/gtcache` reports `vg.sizeBytes` 1 598 029 824 — the concat VG
  plus the cache slice — while `lv.sizeBytes` and the whole `capacity` block stay
  correct (1 065 353 216 usable, `rawBytes` counts only the two member disks).
  Any consumer deriving pool size from `vg.sizeBytes` inherits the cache slice.
- A cache disk that comes *back* after being declared dead carries an outdated
  PV label, and every LVM command on the node then prints
  `WARNING: outdated PV /dev/sdd1 seqno 5 has been removed in current VG gtcache
  seqno 9`. The repair path has to wipe the returning slice, not just forget it.

**GT-24 — The 11.15 telemetry sampler keeps resolving, but its I/O tree stops
summing.** `/dev/mapper/gtcache-gtcache--vol` still resolves to `dm-0`
(`readlink -f` unchanged), so no sampler code breaks — the origin moves to a
hidden LV and the cache target keeps the public dm number:

```
# dmsetup ls --tree
gtcache-gtcache--vol (252:0)
 ├─gtcache-gtcache--vol_corig (252:4) └─ (9:127)
 ├─gtcache-gtcache--cache_cvol-cdata (252:2) └─gtcache-gtcache--cache_cvol (252:1) └─ (8:49)
 └─gtcache-gtcache--cache_cvol-cmeta (252:3) └─gtcache-gtcache--cache_cvol (252:1) └─ (8:49)
# dmsetup table
gtcache-gtcache--vol: 0 2080768 cache 252:3 252:2 252:4 128 2 metadata2 writethrough mq 0
gtcache-gtcache--vol_corig: 0 2080768 linear 9:127 2048
```

One warm 256 MiB read pass, measured across `/proc/diskstats`: pool LV `dm-0`
**+525 216 sectors** (the whole read), band `md127` **+31 744 sectors** (6 %),
cache slice `sdd1` **+493 472 sectors** — invisible to the sampler, which never
looks at it. So on a cached pool the dashboard's pool row legitimately exceeds
the sum of its bands, and the cache is where the difference went. The pool
detail's `cache` block is the only honest place to put it.

Note for the design text: `dmsetup table` renders the policy as `mq` even though
`lvs` reports `cache_policy: smq` (the kernel's smq module registers under both
names), and the status line's `sequential_threshold 0 / random_threshold 0` are
mq-era knobs that smq does not use. §13's parenthetical "sequential I/O
bypasses" is an mq property; under smq, sequential detection is internal and not
tunable. `lvs` is the source of truth for mode and policy; `dmsetup status` is
the source of truth for *health*.

A verbatim `lvs -a … --reportformat json` capture of the cached pool (hidden
`_cvol` / `_corig` sub-LVs, all cache columns populated) is saved as
`packages/daemon/src/fixtures/ahr/lvs-cached-pool.json`.

### Teardown

Cache uncached, `gtcache` destroyed through the API (`DELETE /v1/ahr/gtcache`,
confirm-code flow, job completed), disks 7/8/9 wiped and detached. Node
verified clean: `zpool list` shows only `gtbackup`/`gtiscsi`, `lvs`/`vgs`/`pvs`
and `mdadm --detail --scan` empty, `/proc/mdstat` `unused devices: <none>`, no
`anas-ahr` line in `/etc/fstab`, no btrfs mounts, `GET /v1/ahr` → `{"data":[]}`
and `GET /v1/disks` → the system disk only.
