# AHR — fixture provenance (Epic 11 + AHR read layer)

All genuine fixtures are the **exact bytes** captured during the stage-0 ground-truth
build on the stunt PVE 9 node (`anas-pve`, 192.168.200.50), 2026-07-22 — the live
2/3/4 "TB" worked example at 1:2048 scale (1024/1536/2048 MiB virtual disks,
`scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT*`). See docs/AHR-GROUND-TRUTH.md; the raw
phase logs lived in the session scratchpad (phase-a/b/c1/d/f). Environment:
pve-manager 9.2.4, kernel 7.0.14-5-pve, mdadm 4.4, LVM 2.03.31, btrfs-progs 6.14.

## Genuine captures (verbatim log extracts)

| File | Source | What it is |
|------|--------|------------|
| `mdstat-initial-recovery.txt` | phase-a | `/proc/mdstat` right after create: md127 raid5 in initial `recovery` (percent/finish/speed line, `[3/2] [UU_]`), md126 raid1 with the tab-indented `resync=DELAYED` marker |
| `mdstat-clean.txt` | phase-a | Same two arrays after initial sync — no sync lines, `[3/3] [UUU]` |
| `mdstat-expanded.txt` | phase-b | Three arrays after online expansion (r2 converted raid1→raid5, new md125 r3). Note kernel numbers INVERTED from creation order (GT-2) |
| `mdstat-reshape-degraded.txt` | phase-c1 | The failure-gauntlet state: md127 `reshape` line + faulted member `sdb1[0](F)`, `[5/4] [_UUUU]` — the "clean, degraded, reshaping" drill |
| `mdstat-replace-fragment.txt` | phase-d | `grep -A3 md127` fragment during live `--replace`: replacement member `sdg1[7](R)` + `recovery` line. Deliberately partial (no Personalities header) — drift-tolerance input |
| `mdadm-export-r1.txt` | phase-a | `mdadm --detail --export /dev/md/ahr0-r1` — KEY=VALUE incl. homehost-prefixed `MD_NAME=anas-pve:ahr0-r1` (GT-3) and per-member `MD_DEVICE_*_ROLE/_DEV` |
| `mdadm-export-r2.txt` | phase-a | Same for the raid1 band array |
| `lvm-pvs.json` / `lvm-vgs.json` / `lvm-lvs.json` | phase-a | `pvs/vgs/lvs --reportformat json` — **captured WITHOUT `--units b --nosuffix`** (stage-0 script omission), so sizes carry lvm's human suffixes (`508.00m`, `<2.49g`). The parser targets the byte form (its exported ARGS include the units flags) but tolerates this suffixed form; suffixed values round-trip approximately, byte values exactly |
| `btrfs-usage.txt` | phase-a | `btrfs filesystem usage -b` — full output: Overall block + Data/Metadata/System profile sections + Unallocated |
| `btrfs-usage-truncated.txt` | phase-b | Same command piped through `head -12` in the capture script — Overall block only. Kept as the format-drift tolerance case (GT-14: read free space, never precompute) |
| `lsblk-ahr-capture.json` | phase-a | `lsblk -J -b -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,PARTLABEL` — verbatim. **Incomplete**: the capture script listed `/dev/sdb /dev/sdc /dev/sde` and sde did not exist, so disk sdd (HOT3) is missing from this genuine capture |

## Genuine captures — story 11.12 subvolume-layout (added 2026-07-23)

Live-captured on the stunt node (`anas-pve`, btrfs-progs **v6.14**) during the
11.10–11.12 live-proof, on pool `tank` (subvol layout) AFTER a rollback — so the
set includes the writable `pre-rollback-*` preserve. **These replaced the
earlier synthetic modellings** (which used `top level 5` for snapshots; the real
value is `top level 257` = the `@snapshots` subvolume id — a data difference the
parser already tolerated, but now the fixtures are ground truth).

| File | Source | What it is |
|------|--------|------------|
| `btrfs-subvol-list-s.txt` | live | `btrfs subvolume list -s /mnt/anas-ahr/tank` — the two operator snapshots (`cgen`+`otime`, `top level 257`) plus the post-rollback writable `@data` (itself a snapshot, `top level 5`). NOTE the pre-rollback preserve is ABSENT — a plain subvolume, invisible to `-s`; this is exactly why `listAhrSnapshots` enumerates the PLAIN list instead |
| `btrfs-subvol-list-r.txt` | live | `btrfs subvolume list -r /mnt/anas-ahr/tank` — the read-only set (the two operator snapshots only; the writable pre-rollback and `@data` are excluded). No `otime`/`cgen` column in `-r` |
| `btrfs-subvol-list-layout.txt` | live | plain `btrfs subvolume list /mnt/anas-ahr/tank` — `@data`, `@snapshots`, both operator snapshots, AND the writable `@snapshots/pre-rollback-*` preserve. The membership source `listAhrSnapshots` reads |
| `btrfs-subvol-list-flat.txt` | live | empty output — captured on the pre-§12 FLAT `tank` before it was destroyed (a flat pool has no subvolumes) |

## Genuine captures — story 11.15 I/O telemetry (added 2026-07-24)

Live-captured on the stunt node (`anas-pve`, 192.168.200.50), pool `tank`
(RAID5×4 + RAID5×4 over 5 disks + 1 hot spare `sde`), kernel 7.1 `/proc/diskstats`.
Two snapshots taken ~1s apart with an 80 MiB `dd … oflag=direct` write to
`/mnt/anas-ahr/tank` in between (probe file deleted after), so the delta carries
a real write burst — the exact bytes `parseDiskstats` + `diskstatsToIoStats`
target. Device map at capture time (resolved via the pin symlinks):
`/dev/mapper/tank-tank--vol → dm-0`, `/dev/md/tank-r1 → md127`,
`/dev/md/tank-r2 → md126`; band-r1 members `sdd1 sdf1 sdg1 sdm1` (+ spare `sde1`),
band-r2 `sdd2 sdf2 sdg2 sdm2` (+ spare `sde2`).

| File | Source | What it is |
|------|--------|------------|
| `diskstats-tank-t0.txt` | live | `/proc/diskstats` BEFORE the 80 MiB write — the t0 cumulative counters |
| `diskstats-tank-t1.txt` | live | same, AFTER the write + `sync` + `sleep 1` — dm-0/md127 show the write delta (`wr_sectors` 59024→224032 on dm-0), md126 idle. The delta→rate / await derivation and the fail-open sampler are tested against this pair |

The kernel `/proc/diskstats` format is documented-stable, but captured anyway
per the ground-truth idiom (never build a parser against an assumed format).

## Reconstructed / synthetic (NOT verbatim captures — labeled honestly)

| File | Status | Notes |
|------|--------|-------|
| `lsblk-ahr0.json` | **Reconstructed** | The complete phase-a tree: `lsblk-ahr-capture.json` (sdb, sdc verbatim) plus the missing sdd entry rebuilt from the same session's `sgdisk -p` sector table (sdd1 = sectors 2048–2097151 → 1072693248 B; sdd2 = 2097152–3145727 → 536870912 B; sdd3 = 3145728–4194270 → 536854016 B, raw/unused) and `/proc/mdstat` membership. Used by the dev-mode mock and topology tests |
| `mdstat-inactive-spares.txt` | **Synthetic** | The GT-8 shape (post-power-loss degraded-reshape assembly: array `inactive`, all members `(S)`). The live drill proved the state but its mdstat bytes were not retained in the phase logs — format follows the kernel's md driver output. Replace with a live capture when next drilled |
| `findmnt-ahr0.json` | **Synthetic** | `findmnt --json --real` including the ahr0 btrfs mount. Stage-0 verified the mount via `df`/`btrfs fi show` only; no findmnt capture exists. Shape matches the genuine findmnt fixtures in `../mounts/` |

## Known gaps (for the next capture pass)

- `mdadm --detail --scan` output was never captured — the topology reader
  deliberately discovers arrays via `/proc/mdstat` + per-array
  `--detail --export` instead (both shapes ARE captured).
- `pvs/vgs/lvs --reportformat json --units b --nosuffix` (the byte form the
  daemon actually runs) — only the suffixed form was captured.
- `/proc/mdstat` for the GT-8 inactive-all-spares state (see above).
- `--detail --export` of an array with a faulty/spare member — member STATE
  therefore comes from `/proc/mdstat` flags, not from export keys.

In dev mock mode these fixtures replay the phase-a pool (`ahr0`: raid5×3 +
raid1×2 → LVM → btrfs, healthy, mounted). The by-id listing in mock mode is the
shared `../system/disk-by-id.txt`, so mock AHR disks resolve to the WD sample
ids rather than the ANAS_HOT ids of the real capture.
