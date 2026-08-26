# iSCSI fixtures — provenance

Captured for story **iscsi.1** on **2026-08-25** on the stunt node (`anas-pve`,
192.168.200.50) — a disposable PVE 9 VM. Nothing here comes from a production host.
The write-up built on these captures is `docs/ISCSI-GROUND-TRUTH.md`.

## Node / versions (from `package-versions.txt`)

```
targetcli-fb            1:2.1.53-1.3
python3-rtslib-fb       2.1.76-3
python3-configshell-fb  1:2.0.0-2
python3-pyudev          0.24.3-1
python3-pyparsing       3.1.2-1
python3-gi              3.50.0-4+b1
open-iscsi              2.1.11-1+deb13u2   (already installed — NOT added by us)
sg3-utils               1.48-2+pmx1        (already installed)
pve-manager             9.2.11/f6997e698c7933ea
kernel                  7.0.14-12-pve
zfs                     2.4.3-pve1
Debian                  13 (trixie)
```

## Every file: real capture vs synthetic

**All files in this directory are REAL CAPTURES** — verbatim stdout/stderr or verbatim
file contents from the stunt node. **No file is synthetic.** Only two kinds of edit were
made, both noted in the table below: the CHAP-secret redaction (see "Redactions") and one
stripped ssh banner line in `boot-ordering-units.txt`. Nothing else was touched.

## Added for `iscsi.6` (2026-08-25, second read-only pass on the same stunt node)

Two more real captures, both plain stdout, nothing written to the node:

| File | What it is | Provenance |
|---|---|---|
| `lsblk-zd-tran.json` | `lsblk -J -o NAME,TYPE,KNAME,SERIAL,SIZE,TRAN` | REAL capture. Three `zd*` entries reported as `"type": "disk"` — the GT-43 inventory hazard, now the fixture for the `parsers/lsblk.ts` filter. **The node's own initiator was logged OUT for this capture** (the wave-1 live proof left it that way and it was deliberately not logged back in), so no `tran: "iscsi"` row appears here; the iSCSI-transport rows with their real serials are in `anasd-v1-disks.json` from the `iscsi.1` run. |
| `pve-firewall-status-disabled.txt` | `pve-firewall status` | REAL capture, exit 0. The node's firewall was never enabled (GT open question 5), so this is the DISABLED half of the advisory only. `/etc/pve/firewall/` was an empty directory — no `cluster.fw`, no `host.fw`. The ENABLED cases (rule present / rule absent) could not be captured read-only and are driven from `.fw` files written into a temp dir by `services/__tests__/pve-firewall.test.ts`, which labels them as such; **they owe a live proof in `iscsi.7`**. |

| File | What it is | Provenance |
|---|---|---|
| `package-versions.txt` | `dpkg-query -W` + `pveversion` + `uname -r` + `zfs --version` | real capture |
| `rtslib-fb-targetctl.service.txt` | `systemctl cat rtslib-fb-targetctl.service` | real capture |
| `boot-ordering-units.txt` | `systemctl cat` + `is-enabled` for the 8 units that decide boot order (`zfs-import@`, `zfs-import.target`, `zfs-import-cache`, `zfs-mount`, `zfs-volume-wait`, `zfs-volumes.target`, `zfs.target`, `rtslib-fb-targetctl`). The single leading `Warning: Permanently added …` line from ssh was deleted; nothing else edited. | real capture |
| `lsmod-target.txt` | `lsmod \| grep -E 'target\|iscsi\|configfs'` after the first mutation | real capture |
| `targetcli-get-global.txt` | `targetcli "get global"` — the shipped preference defaults | real capture |
| `targetcli-timing.txt` | `time targetcli ls` and `time targetcli "ls /iscsi"` (warm) | real capture |
| `targetcli-ls.txt` | `targetcli ls` on the final state (2 LUNs, 2 ACLs, CHAP). **Reference only — never parsed.** | real capture |
| `saveconfig-acl-nochap.json` | state A: 1 target / 1 TPG / 3 portals (v4 + v6 + a dummy v4) / 2 LUNs / 2 explicit ACLs / no CHAP | real capture, redacted* |
| `saveconfig-tpu-acl.json` | state B: as A plus `emulate_tpu=1 emulate_tpws=1` on both backstores | real capture, redacted* |
| `saveconfig-chap-mutual.json` | state C: as B plus TPG-level CHAP **and** per-ACL one-way + mutual CHAP | real capture, redacted* |
| `saveconfig-full-2luns-chap.json` | state D: the config that was fed to the missing-backing-device restore drills | real capture, redacted* |
| `saveconfig-final.json` | the state the node was LEFT in: 1 portal, 2 LUNs, 2 ACLs, per-ACL mutual CHAP | real capture, redacted* |
| `configfs-tree.txt` | `find /sys/kernel/config/target -maxdepth 6 \| sort` on the final state | real capture |
| `configfs-acl-info-loggedin.txt` | `.../tpgt_1/acls/<iqn>/info` **with** a live session | real capture |
| `configfs-acl-info-nosession.txt` | the same file for an ACL with **no** session | real capture |
| `configfs-dynamic-sessions-empty.txt` | `.../tpgt_1/dynamic_sessions` — **empty**, because `generate_node_acls=0` | real capture (0 bytes) |
| `sessions-detail-loggedin.txt` | `targetcli "sessions detail"` + `sessions list` with one session | real capture |
| `backstore-block-info-attrs.txt` | `info` + full `get attribute` for the `block` backstore | real capture |
| `backstore-fileio-info-attrs.txt` | `info` + full `get attribute` for the `fileio` backstore | real capture |
| `tpg-attrs-params-auth.txt` | TPG `get attribute` / `get parameter` / `get auth` + `/iscsi get discovery_auth` | real capture, redacted* |
| `ss-portals.txt` | `ss -lntp \| grep 3260` with 3 portals bound (v4, dummy v4, v6 ULA) | real capture |
| `initiator-discovery.txt` | `iscsiadm -m discovery -t sendtargets` | real capture |
| `lsblk-initiator-loggedin.json` / `.txt` | `lsblk -J`/`lsblk` with both LUNs logged in locally | real capture |
| `lsblk-with-lun-and-loop.json` | `lsblk -J` with LUNs **plus** a `/dev/loop0` and two `/dev/zd*` present | real capture |
| `dev-disk-by-id.txt` | `ls -la /dev/disk/by-id/` showing `scsi-3<naa>` and `wwn-0x<naa>` for both LUNs | real capture |
| `initiator-sg_inq-block.txt` | `sg_inq` + VPD pages `0x80`, `0x83`, `0xb0`, `0xb2` for the zvol LUN | real capture |
| `initiator-sg_inq-fileio.txt` | the same for the fileio LUN | real capture |
| `anasd-v1-disks.json` | `curl --unix-socket /run/anas/anasd.sock http://localhost/v1/disks` (anasd 0.2.11) | real capture |
| `rtslib-backup-dir.txt` | `ls -la /etc/rtslib-fb-target/backup/` — targetcli's own rotating `.gz` backups | real capture |
| `error-texts.txt` | 11 numbered failure/edge cases, each with initiator-side text, exit code and the target-side kernel journal | real capture |
| `configfs-live.manifest` | The whole live configfs subtree the read layer touches (`/sys/kernel/config/target`, minus `statistics/`, `alua/`, `pr/`, `fabric_statistics/` and `core/alua`), captured **2026-08-25 for story `iscsi.2`** as a flat one-line-per-node manifest: `D <rel>` / `L <rel> -> <target>` / `F <rel> = <content, newline-escaped>`. Materialised into a temp directory by `src/fixtures/configfs-manifest.ts` so the path-injectable configfs reader can be pointed at it. Same node, same target, after the GT-47 reboot (hence `zd16`). | real capture, redacted* |
| `configfs-restore-hole.manifest` | **DERIVED, not a raw capture** — `configfs-live.manifest` with the `core/iblock_0`, `tpgt_1/lun/lun_0` and `acls/*/lun_0` subtrees deleted, reproducing the GT-20/GT-21 state: the block backing device was missing at restore, so LIO skipped the storage object and the LUN while systemd still reported success. Paired with `saveconfig-final.json` (which still has both LUNs) it is the restore-hole diff. | derived from the real capture |
| `configfs-restore-empty.manifest` | **DERIVED, not a raw capture** — `configfs-restore-hole.manifest` with the `core/fileio_1`, `tpgt_1/lun/lun_1` and `acls/*/lun_1` subtrees deleted too, so NOTHING is left under `tpgt_1/lun/`. This is the second half of GT-21: with the whole pool late, the target restores **enabled and listening with zero LUNs** and an initiator logs in successfully and sees no disks. Paired with `saveconfig-final.json` (two LUNs) it is the `targetsServingNothing` case story `iscsi.5` cards. | derived from the real capture |
| `reboot-real.txt` | the **real reboot** at the end of the run: unit timeline, service result, the `zd0`→`zd16` move, serials after boot, and the initiator's identity + verified marker checksum. The single leading `Warning: Permanently added …` ssh line was deleted; nothing else edited. | real capture |

\* **Redactions (the only edits made to any file):** the two throwaway 16-character CHAP
secret values (one incoming, one mutual) were replaced with the literal
`REDACTED-16char` (same length) in `saveconfig-*.json`, `tpg-attrs-params-auth.txt` and
the `auth/password*` lines of the two `configfs-*.manifest` files.
The JSON keys (`chap_password`, `chap_mutual_password`), the userids
(`gtiscsiuser`, `gtacluser`, `gttargetuser`) and every other byte are untouched.
The real values are recorded in `/root/anas-iscsi-gt-handles.txt` (0600) on the node.

## Handles left on the node

See `/root/anas-iscsi-gt-handles.txt` (mode 0600) for the full list. Summary:

- ZFS pool `gtiscsi` on the file vdev `/var/tmp/gtiscsi.img`; `gtiscsi/vol1` (2G zvol,
  16K volblocksize, carries an ext4 `GTISCSI1` with a checksummed marker file);
  `gtiscsi/images` with the 1 GiB sparse `lun2.raw`.
  A file-vdev pool does **not** auto-import at boot: `zpool import -d /var/tmp gtiscsi`.
- LIO target `iqn.2026-08.dev.anas.gtiscsi:target1`, tpg1 enabled, portal
  192.168.200.50:3260, lun0 = block/zvol, lun1 = fileio, two explicit ACLs, per-ACL
  one-way + mutual CHAP, `authentication=1`.
- The node's own open-iscsi initiator is logged in (sdb = lun0, sdc = lun1) with a
  `node.startup=manual` record.
- The PVE storage entry `gtiscsi-pve` was added, proven and **removed**. The dummy
  interface `gtdummy0` and the loop device used for the inventory capture were removed.
- `/run/anas-gt/iscsi` was removed at the end of the run.
