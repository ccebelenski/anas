# System fixtures — provenance

The "ground truth first" ruling asks every fixture to be labelled **real capture** vs
**synthetic**. This directory predates that labelling, so this file records what is known
about the files it covers rather than pretending it was always written down.

## ATA identity documents (disks.1 rider 1 — the power mode)

| File | `power_mode` | Label |
|------|--------------|-------|
| `smartctl-ata-identity.json` | `{ "ata_value": 255, "name": "ACTIVE or IDLE" }` | smartctl 7.5 documented shape + values from the 2026-09-10 fleet capture; replace with a verbatim capture when one is committed |
| `smartctl-ata-identity-idle.json` | `{ "ata_value": 129, "name": "IDLE_A" }` | smartctl 7.5 documented shape + values from the 2026-09-10 fleet capture; replace with a verbatim capture when one is committed |

Both documents are hand-built around a real drive's identity fields in smartctl 7.5's
`--json` shape. The part that matters — the `power_mode` object — is not guessed: the
2026-09-10 fleet capture recorded `255 "ACTIVE or IDLE"` on an awake ATA drive and
`129 "IDLE_A"` on one that had idled down, and smartmontools 7.5's own name table is
`ACTIVE or IDLE`, `ACTIVE_NV_UP`, `ACTIVE_NV_DOWN`, `IDLE_A`, `IDLE_B`, `IDLE_C`,
`STANDBY_Y`. The key is `name`, **not** `string` — the parser read `power_mode.string`
until the disks.1 fix batch, which would have reported no mode at all on every real ATA
drive.

Neither file was committed as verbatim daemon stdout. When a full `-n standby -iH --json`
capture from a live ATA drive lands in the tree, replace these outright rather than
patching values into them.

## The rest

`smartctl.json`, `smartctl-standby-skip.json`, `smartctl-open-device-failed.json`,
`lsblk.json`, `lsblk-ceph.json` and `disk-by-id.txt` predate this file and carry no
recorded provenance. Nothing here should be read as a claim that they are real captures;
label them the next time one of them is touched for a story.

## The ZFS-root node (disks.r1, captured 2026-11-14)

`lsblk-zfs-root.json`, `zpool-status-zfs-root.json` and `disk-by-id-zfs-root.txt` are verbatim
stdout from one PVE 9 test VM that boots from ZFS, taken in one sitting:

| File | Command |
|------|---------|
| `lsblk-zfs-root.json` | `lsblk -Jb -o NAME,TYPE,SIZE,MODEL,SERIAL,TRAN,FSTYPE,MOUNTPOINT,ROTA,PHY-SEC,LOG-SEC,WWN,VENDOR,REV` (the daemon's own `LSBLK_ARGS`) |
| `zpool-status-zfs-root.json` | `zpool status -jv` |
| `disk-by-id-zfs-root.txt` | `ls -la /dev/disk/by-id/` |

The mount table of the same node is `../mounts/findmnt-zfs-root.json` (`findmnt --json`).

What the capture settles: the boot disk `sda` has NO partition mounted anywhere (`sda1` BIOS
boot, `sda2` an unmounted vfat ESP, `sda3` a `zfs_member`), so nothing in lsblk says it is the
system disk; the only fact is the mount table's `/` on `rpool/ROOT/pve-1` plus `sda3` being a
leaf of `rpool`. `sdb` (ext4 partition) and `sdc` (whole-disk ext4) are data mounts; `sdd`-`sdf`
are an AHR pool.
