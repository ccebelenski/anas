# iSCSI — Stunt-Node Ground Truth (story `iscsi.1`)

> Captured 2026-08-25 on the stunt node (PVE 9.2.11, kernel 7.0.14-12-pve, Debian 13
> trixie, ZFS 2.4.3-pve1) with `targetcli-fb 1:2.1.53-1.3` / `python3-rtslib-fb 2.1.76-3`
> and the node's own `open-iscsi 2.1.11-1+deb13u2` as the initiator. A throwaway pool
> `gtiscsi` on a file vdev carried both backing kinds: a 16K-`volblocksize` zvol
> (`block` backstore) and a sparse raw image on a dataset (`fileio` backstore).
> The target was built, connected to, authenticated, resized, UNMAPped, restored with
> its backing devices missing, consumed by PVE's stock `iscsi:` plugin, and collided
> with every ZFS verb. Fixtures — all real captures — are in
> `packages/daemon/src/fixtures/iscsi/` with `NOTES.md` labelling each one.
>
> A **real reboot** was performed at the end of the run — see GT-47/GT-48.

---

## What was proven end-to-end

1. **Build**: `apt-get install targetcli-fb python3-rtslib-fb` → target + TPG + a portal
   bound to a *specific* address + 2 LUNs (block on a zvol, fileio on a sparse file) +
   2 explicit initiator ACLs + one-way CHAP + mutual CHAP. All from `targetcli` argv.
2. **Connect**: local `open-iscsi` login; ACL rejection of an unlisted initiator; CHAP
   rejection with the wrong secret; one-way and mutual CHAP success; sessions enumerated
   from configfs and from `targetcli sessions`.
3. **Identity**: unit serial read back end-to-end (`vpd_unit_serial` → `/dev/disk/by-id`
   → `lsblk SERIAL/WWN` → `sg_vpd`); **serial replay across a delete + recreate proven
   in both directions** (without → identity changes; with → identity restored).
4. **Resize**: zvol grow is live end-to-end; **fileio size is fixed at creation** and can
   only be changed by delete + recreate (serial replayed).
5. **Thin reclaim**: `emulate_tpu`/`emulate_tpws` off by default; turned on, `blkdiscard`
   from the initiator returned a 515 MiB zvol to 12K `referenced` and a 256 MiB image file
   to 512 bytes allocated.
6. **Boot restore drills**: one backing device missing, then the whole pool missing, then
   healed — the service reports **success in every case**. Plus a **real reboot** at the end
   of the run: everything restored, serials, attributes and data intact.
7. **PVE consumes it**: `pvesm add iscsi … --content none` → `pvesm status` active,
   `pvesm list` shows both LUNs, with zero ANAS involvement. Entry removed afterwards.
8. **Collisions**: `zpool export` and `zfs destroy` are refused while a LUN holds the
   backing object; **`zfs rollback`, `zfs rename` and a `volsize` shrink are NOT**.

---

## Facts the code must honor (numbered for reference)

### Packages, service, modules

**GT-1 — The two packages pull in 9 and enable the restore service themselves.**
`apt-get install -y targetcli-fb python3-rtslib-fb` installs `targetcli-fb 1:2.1.53-1.3`,
`python3-rtslib-fb 2.1.76-3`, `python3-configshell-fb 1:2.0.0-2`, `python3-pyudev`,
`python3-pyparsing`, `python3-gi`, `gir1.2-glib-2.0`, `gir1.2-girepository-2.0`,
`libgirepository-1.0-1`. The `python3-rtslib-fb` postinst does:

```
Created symlink '/etc/systemd/system/multi-user.target.wants/rtslib-fb-targetctl.service'
  → '/usr/lib/systemd/system/rtslib-fb-targetctl.service'.
```

and the unit starts immediately:

```
Active: active (exited) since Tue 2026-08-25 19:14:56 UTC
target[350392]: No saved config file at /etc/rtslib-fb-target/saveconfig.json, ok, exiting
```

**The installer must not "enable and start" it — that is already done.** It must only add
the ordering drop-in (GT-3).

**GT-2 — `open-iscsi` (the initiator) is already on a PVE 9 node** — 2.1.11-1+deb13u2,
along with `sg3-utils`. PVE ships it for its own `iscsi:` storage type. ANAS does not
install anything on the initiator side. `iscsid.service` is socket-activated and
`disabled`; `open-iscsi.service` is enabled but condition-gated.

**GT-3 — the shipped unit has NO storage ordering.** Verbatim
(`fixtures/iscsi/rtslib-fb-targetctl.service.txt`):

```
[Unit]
Description=Restore LIO kernel target configuration
Requires=sys-kernel-config.mount
After=sys-kernel-config.mount network.target local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=mkdir -p /etc/rtslib-fb-target
ExecStart=/usr/bin/targetctl restore
ExecStop=/usr/bin/targetctl clear
SyslogIdentifier=target
```

No `After=zfs-import.target`, no `zfs-mount.service`, no AHR/md/LVM ordering, and nothing
at shutdown beyond `ExecStop=targetctl clear` (which is unordered relative to pool export).
`iscsi.5`'s drop-in is required, in both directions.

**GT-3b — the ordering anchors that already exist on a PVE 9 node.** All four of these
are `enabled` on the stunt node out of the box:

```
zfs-import@<pool>.service   Before=zfs-import.target  (this is what ANAS's own
                            zfs-import-unit.ts enables per pool — so ordering after
                            zfs-import.target covers BOTH it and zfs-import-cache)
zfs-mount.service           After=zfs-import.target   Before=local-fs.target
zfs-volume-wait.service     After=zfs-import.target   ExecStart=/usr/bin/zvol_wait
zfs-volumes.target          Requires/After=zfs-volume-wait.service, WantedBy=zfs.target
```

This matters more than it looks. The shipped `After=local-fs.target` (GT-3) already puts
the restore **after `zfs-mount.service`** transitively — which is why a *fileio* LUN on a
dataset is usually fine — but **nothing** in that chain waits for `/dev/zvol/*` symlinks.
The anchor for a **zvol**-backed LUN is `zfs-volumes.target` / `zfs-volume-wait.service`,
and the drop-in must name it (`Wants=` + `After=`), not just `zfs-import.target`.

**GT-4 — module loading is not lazy in any useful sense.** `targetctl restore` with no
saved config loads `target_core_mod` alone. The **first** `targetcli` invocation that
touches a backstore or fabric loads the lot:

```
target_core_user, uio, target_core_pscsi, target_core_file, target_core_iblock,
iscsi_target_mod, target_core_mod
```

`target_core_pscsi` and `target_core_user` are loaded even though ANAS never uses them —
rtslib probes every backstore plugin. "Modules loaded on first use only" cannot be
engineered from ANAS's side; it is rtslib's behaviour and it is all-or-nothing.

### Driving targetcli

**GT-5 — one command per invocation; `targetcli CMD` is the ONLY form with a trustworthy

> **Amendment (iscsi.4 build, 2026-08-25):** `targetcli` joins its argv with spaces and parses ONE configshell command line — so the daemon passes `['/iscsi', 'create', iqn]` as plain argv (no shell quoting anywhere); `"cd /x; ls"` is rejected as two positional parameters, and configshell refuses batching by construction.

exit code.** Three forms exist and they differ dangerously:

| form | multiple commands | exit code on failure | auto-saves |
|---|---|---|---|
| `targetcli "<one cmd>"` (argv) | no | **1** | no |
| `targetcli` reading stdin | yes | **always 0** | **yes, on `exit`** |
| `targetcli "cd /x; ls"` | rejected | 1 | — |

Semicolon chaining: `Got 2 positionnal parameters, expected at most 1.` (exit 1).
Stdin batching *works* but **continues past a failed command and still exits 0**, and then
`auto_save_on_exit=true` **persists the half-applied state**:

```
/> Could not open /dev/does-not-exist
/> o- block ... [Storage Objects: 1]
/> Global pref auto_save_on_exit=true
Configuration saved to /etc/rtslib-fb-target/saveconfig.json
targetcli(pipe) exit=0
```

**GT-6 — cost is not a reason to batch.** `targetcli ls` (full tree) = 0.409 s cold,
0.154 s warm; `targetcli "ls /iscsi"` = 0.087 s warm. Milliseconds, not seconds.

**GT-7 — targetcli's own preference defaults change behaviour and live in `$HOME`.**
`/root/.targetcli/prefs.bin` (a Python pickle) plus `history.txt` and `log.txt` are created
on first use. The defaults that matter (`fixtures/iscsi/targetcli-get-global.txt`):

```
auto_add_default_portal=true    ← creates a 0.0.0.0:3260 portal on every new target
auto_add_mapped_luns=true       ← auto-maps every TPG LUN into every ACL
auto_enable_tpgt=true           ← a new TPG is live the moment it exists
auto_save_on_exit=true          ← shell/stdin mode writes saveconfig.json on exit
max_backup_files=10             ← rotating .gz copies in /etc/rtslib-fb-target/backup/
export_backstore_name_as_model=true  ← backstore name becomes the SCSI model string
auto_use_daemon=false           ← targetclid.service/.socket exist but are disabled
```

**GT-8 — `auto_add_default_portal` must be dealt with, and it is conditional.** Creating a
target emits:

```
Created target iqn.2026-08.dev.anas.gtiscsi:target1.
Created TPG 1.
Global pref auto_add_default_portal=true
Created default portal listening on all IPs (0.0.0.0), port 3260.
```

— which directly violates the epic's "portal bound to a chosen address". But on a **second**
target it instead prints `Default portal not created, TPGs within a target cannot share
ip:port.` So the post-create state is not deterministic: ANAS must delete any `0.0.0.0`
portal it did not ask for (idempotent), not assume one exists.

**GT-9 — `targetcli saveconfig <path>` writes an arbitrary file.** Proven. LIO also keeps
**its own** rotating gzipped backups without being asked:

```
/etc/rtslib-fb-target/backup/saveconfig-20260825-19:17:50-json.gz   (0600, drw------- dir)
```

one per `saveconfig`, capped by `max_backup_files=10`. Note the **colons in the filename**.

**GT-10 — there is no rename.** `/iscsi` offers only `create [wwn]` and `delete wwn`;
backstores likewise. A target rename *is* a delete + create. targetcli's own generated IQN
is `iqn.2003-01.org.linux-iscsi.<hostname>.x8664:sn.<12 hex>` — it embeds the hostname, so
ANAS must generate its own.

### saveconfig.json — the persisted config

**GT-11 — shape.** Three top-level keys: `fabric_modules` (empty in practice),
`storage_objects[]`, `targets[]`. Empty config is exactly:

```json
{
  "fabric_modules": [],
  "storage_objects": [],
  "targets": []
}
```

A storage object carries `name`, `plugin` (`block`|`fileio`), `dev`, `wwn`, `readonly`,
`write_back`, a full `attributes{}` map, `alua_tpgs[]`, and — **fileio only** — `size` and
`aio`. A target carries `wwn` (the IQN), `fabric`, `parameters{}` and `tpgs[]`; a TPG
carries `tag`, `enable`, `attributes{}`, `parameters{}`, `luns[]`, `node_acls[]`,
`portals[]`. See `fixtures/iscsi/saveconfig-final.json`.

**GT-12 — parser traps in saveconfig.json.**
- An IPv6 portal's `ip_address` is stored **with brackets**: `"[fd00:6774:0:1::1]"`.
  IPv4 is bare. Any address comparison must normalise.
- `luns[].alias` and `node_acls[].mapped_luns[].alias` are **random 10-hex strings
  regenerated on every create** (`"6847ded961"`). They are not identity; ignore them.
- `attributes{}` in saveconfig is a fixed set that does **not** match `get attribute`
  output exactly (e.g. `emulate_3pc` appears in saveconfig and in configfs for a fileio
  object but not in its `get attribute` view). Read attributes from configfs, not from a
  diff against saveconfig.
- CHAP secrets are **plaintext**: `chap_userid`, `chap_password`, `chap_mutual_userid`,
  `chap_mutual_password` (note: the JSON key names differ from targetcli's
  `set auth userid=/password=/mutual_userid=/mutual_password=`). The file is
  `0600 root:root`, as is the `backup/` directory.

**GT-13 — configfs layout.** `/sys/kernel/config/target/`:
- `core/<plugin>_<index>/<backstore name>/` — **the plugin directory carries a creation
  index** (`iblock_0`, `fileio_1`, and the index moves with creation order). Never hardcode
  it; glob `core/*/<name>`.
- backstore files: `udev_path`, `enable`, `info`, `alias`, `attrib/*`, `wwn/*`, `statistics/*`.
- `wwn/vpd_unit_serial` reads back **with a prefix**:
  `T10 VPD Unit Serial Number: 9bc6e907-6015-4267-be4f-5a0617cb3d71` — strip it.
  `wwn/product_id` is the backstore name, `wwn/vendor_id` is `LIO-ORG`, `wwn/revision` `4.0`.
- `iscsi/<IQN>/tpgt_<n>/` — `enable`, `attrib/`, `auth/`, `param/`, `acls/<initiator IQN>/`,
  `lun/lun_<n>/`, `np/<addr>:<port>/`, `dynamic_sessions`, `fabric_statistics/`.
  IPv6 np directories are **bracketed**: `np/[fd00:6774:0:1::1]:3260`.

### Unit serial / WWN — the identity contract

**GT-14 — one string drives every identity an initiator sees.** LIO derives, from the
backstore's `wwn` (a UUID by default):

```
lsblk SERIAL   9bc6e907-6015-4267-be4f-5a0617cb3d71
lsblk WWN      0x60014059bc6e90760154267be4f5a061        (NAA, company_id 0x001405 + serial)
/dev/disk/by-id/scsi-360014059bc6e90760154267be4f5a061
/dev/disk/by-id/wwn-0x60014059bc6e90760154267be4f5a061
VPD 0x80       Product serial number: 9bc6e907-6015-4267-be4f-5a0617cb3d71
VPD 0x83       NAA 0x60014059bc6e90760154267be4f5a061
               T10 vendor specific: gtiscsi_vol1:9bc6e907-6015-4267-be4f-5a0617cb3d71
```

Note the T10 designator in page 0x83 is `<backstore name>:<serial>` — **the backstore name
is part of the device identity too**, not only the serial.

**GT-15 — the backstore name IS the SCSI model string.** `emulate_model_alias=1` +
`export_backstore_name_as_model=true` mean the initiator's `INQUIRY` reports
`Product identification: gtiscsi_vol1`, `lsblk MODEL = gtiscsi_vol1`. So `iscsi.4`'s
"collision-free encoding" for a flat backstore name is not an internal detail — it is
user-visible on every initiator and is baked into VPD 0x83. Standard INQUIRY pads it to
16 characters.

**GT-16 — the serial is set ONLY at create, as a create parameter.**
`create name dev [readonly] [wwn]` (block) / `create name file_or_dev [size] [write_back]
[sparse] [wwn]` (fileio). There is no `set wwn`. **No format validation whatsoever** —
`abc123`, `0123456789abcdef` and `not-a-uuid-at-all-xxxx` were all accepted. ANAS should
keep LIO's UUID convention.

**GT-17 — serial persistence, proven both ways.** Delete backstore + LUN, then:

| recreate | initiator sees |
|---|---|
| **without** `wwn=` | serial `9f234f3c-…`, NAA `0x60014059f234f3cdaa54c8092d0f7c8b`, **new** `by-id` links — a *different disk* |
| **with** `wwn=9bc6e907-…` | serial, NAA and both `by-id` links **identical to before** |

Block *content* is untouched in both cases (the ext4 label and UUID survived), so the loss
is purely one of SCSI identity — which is exactly what Windows, ESXi **and PVE** key on.

**GT-18 — attributes are NOT carried across a recreate.** A recreated backstore comes back
with stock defaults (`emulate_tpu=0`, `emulate_tpws=0`, `max_unmap_lba_count` back to the
plugin default). Every recreate path must replay attributes as well as the serial.

**GT-19 — boot restore replays the serial for free.** Because `wwn` is in
saveconfig.json, `targetctl restore` recreates the backstore with the original serial.
The serial only escapes when ANAS itself recreates a backstore outside a restore.

### Boot restore with a backing device missing — the silent-hole finding

**GT-20 — a missing backing device is a SUCCESS as far as systemd is concerned.**
With the zvol renamed away and `systemctl restart rtslib-fb-targetctl`:

```
systemctl start exit=0
Result=success
ExecMainStatus=0
ActiveState=active

target[358541]: Could not create StorageObject gtiscsi_vol1: Device /dev/zvol/gtiscsi/vol1 is not a TYPE_DISK block device, skipped
target[358541]: Could not find matching StorageObject for LUN 0, skipped
target[358541]: Could not find matching TPG LUN 0 for MappedLUN 0, skipped
target[358541]: Could not find matching TPG LUN 0 for MappedLUN 0, skipped
systemd[1]: Finished rtslib-fb-targetctl.service - Restore LIO kernel target configuration.
```

The cause is in `/usr/bin/targetctl` itself:

```python
errors = RTSRoot().restore_from_file(restore_file=from_file)
for error in errors:
    print(error, file=err)
```

— collected, printed, **never turned into an exit code.**

**GT-21 — everything else restores; the target comes up with a hole.** After the drill
above: target, TPG (`enable=1`), both ACLs with their CHAP credentials, all portals and
**the other LUN** were restored. LUN 0 simply vanished. With the **whole pool** exported,
the target came up *enabled and listening with zero LUNs* — an initiator logs in
successfully and sees no disks:

```
target[358845]: Could not create StorageObject gtiscsi_vol1: Device /dev/zvol/gtiscsi/vol1 is not a TYPE_DISK block device, skipped
target[358845]: Could not create StorageObject gtiscsi_lun2: [Errno 2] No such file or directory, skipped
… LUNs: 0, ACLs: 2, Portals: 3, ss shows all three listeners
```

Two distinct error texts to match: block → `… is not a TYPE_DISK block device, skipped`;
fileio → `[Errno 2] No such file or directory, skipped`.

**GT-22 — the follow-on trap: a post-boot `saveconfig` erases the record.** After a
degraded restore, LIO's in-memory config no longer contains the missing LUN. Any
`saveconfig` — including the **automatic one** on exiting a stdin-mode targetcli session
(GT-5/GT-7) — writes the truncated config over `saveconfig.json`, and the LUN is gone for
good. ANAS must never `saveconfig` while a restore is known to be incomplete.

**GT-23 — healing is just "device back + restart".** `zfs rename` back →
`systemctl restart rtslib-fb-targetctl` → full config restored, **serial identical**, no
errors in the journal. Same for `zpool import` + restart.

**GT-47 — a REAL reboot restored everything, and the ordering held by luck.**
Timeline from `journalctl -b -o short-precise` (`fixtures/iscsi/reboot-real.txt`):

```
19:56:52.320  Starting zfs-import-cache.service
19:56:52.588  Finished zfs-import-cache.service
19:56:52.592  Starting zfs-volume-wait.service
19:56:52.621  Finished zfs-volume-wait.service      ← /dev/zvol/* links now exist
19:56:52.628  Finished zfs-mount.service
19:56:53.851  Starting rtslib-fb-targetctl.service  ← 1.23 s later
19:56:54.019  Finished rtslib-fb-targetctl.service  (Result=success, no "Could not" lines)
```

Both LUNs came back, both **serials identical**, all **attributes preserved**
(`emulate_tpu=1`, `emulate_tpws=1`, `max_unmap_lba_count=262144`,
`emulate_write_cache=0`), CHAP intact, the portal listening, and after logging in the
initiator saw the same `SERIAL`, the same NAA `WWN`, the same `/dev/disk/by-id` links and
the same data (marker file sha256 matched byte-for-byte).

**But the 1.23 s gap is coincidence, not ordering** — there is no declared dependency
between `zfs-volume-wait.service` and `rtslib-fb-targetctl.service` (GT-3/GT-3b), and this
node has two small file-vdev pools that import in 270 ms. On a node with real disks the
import is seconds to minutes and this race is the GT-20/GT-21 silent hole. The drop-in is
still required; this boot proves the *happy* path, not the absence of the race.

Also note: the pool imported via `zfs-import-cache.service` (`zpool.cache`), even though
its vdev is a file — `zfs-import@gtiscsi.service` was **not** enabled on this pool.

**GT-48 — `zd` kernel numbers move across a reboot; the by-name symlink is what saves the
LUN.** The same zvol was `/dev/zd0` before the reboot and `/dev/zd16` after (its minor
moved because another pool's zvols were created first this boot):

```
/dev/zvol/gtiscsi/vol1 -> ../../zd16
iBlock device: zd16  UDEV PATH: /dev/zvol/gtiscsi/vol1  Major: 230 Minor: 16
```

LIO survives only because `saveconfig.json`'s `dev` is the stable
`/dev/zvol/<pool>/<vol>` path, not `/dev/zdN`. Two consequences: **never store or match a
`zdN` name** (the AHR GT-2 rule, restated for zvols), and the inventory's `id` for a zvol
in `/v1/disks` is currently the kernel name (`"id":"zd16"`, GT-43) — which is not stable
across reboots.

### Portals

**GT-24 — a portal binds to an address that does not exist, silently.** Creating a portal
on `203.0.113.77` (never configured on the box) succeeds, shows `[OK]` in `targetcli ls`,
and appears in `ss -lntp`. Taking the bound interface down, deleting it entirely, and
restarting the service all produce **no error and no journal line** — the portals come
straight back. LIO will never tell ANAS a portal address is gone; `iscsi.6`'s
"portal whose address is gone shows in status" must be computed by ANAS by diffing the
configured portal addresses against the node's actual addresses.

**GT-25 — IPv6 works, link-local does not.** A ULA (`fd00:6774:0:1::1`) portal was created,
listened, and was returned by SendTargets discovery. A **link-local** address is refused:

```
Using default IP port 3260
Could not create NetworkPortal in configFS
targetcli exit=1
```

(no scope-id support). Display is inconsistent: the create message prints
`Created network portal fd00:6774:0:1::1:3260.` (unbracketed, ambiguous) while `ls`,
configfs and saveconfig all bracket it.

### Attributes, resize, thin reclaim

**GT-26 — defaults at create, both kinds** (full lists in the two `backstore-*-attrs.txt`
fixtures). The ones that matter:

| attribute | block (zvol) | fileio (file) |
|---|---|---|
| `emulate_tpu` / `emulate_tpws` | **0 / 0** | **0 / 0** |
| `emulate_write_cache` (`write_back`) | 0 (write-thru) | **1 (write-back)** |
| `block_size` / `hw_block_size` | 512 / 512 | 512 / 512 |
| `max_unmap_lba_count` | 524288 | **8192** |
| `unmap_granularity` | 32 (= the 16K volblocksize) | 1 |
| `max_write_same_len` | 65535 | 4096 |
| `is_nonrot` | 1 | 0 |
| `hw_max_sectors` | 32768 | 16384 |

So `iscsi.4`'s "sensible defaults" work is real: **both** kinds ship with thin reclaim OFF,
and **fileio ships write-back ON** — i.e. the story's "`write_thru` for fileio with
`write_back` behind a data-loss warning" is a *flip* of the shipped default, not a
confirmation of it.

**GT-27 — `block_size` can only be set BEFORE the backstore is in use.** On a fresh
backstore `set attribute block_size=4096` succeeds (`hw_block_size` stays 512). On an
activated one (mapped as a LUN):

```
Cannot set attribute block_size: [Errno 22] Invalid argument
targetcli exit=1
```

**GT-28 — zvol grow is live, end to end, no LIO action needed.**

> **Amendment (iscsi.2 build, 2026-08-25):** the size is NOT in configfs — the `iblock` backstore `info` carries only Status / Max Queue Depth / SectorSize / HwMaxSectors / device / UDEV PATH / Major / Minor / CLAIMED; only `targetcli ls` renders a size (it computes one). The read layer takes a block LUN's size from `/sys/class/block/<kernel>/size × 512`, with the kernel name resolved at point of use (GT-48). Also: `stat -c %s` on any configfs value file is always 4096 — emptiness must be judged from content, never size.

`zfs set volsize=2G` → `targetcli ls` and configfs `info` immediately report 2.0 GiB →
`iscsiadm -m session --rescan` → the initiator sees it:

```
sd 7:0:0:0: [sdb] 4194304 512-byte logical blocks: (2.15 GB/2.00 GiB)
sd 7:0:0:0: [sdb] 16384-byte physical blocks
sdb: detected capacity change from 2097152 to 4194304
```

(LIO reports the zvol's 16K `volblocksize` as the SCSI physical block size.)

**GT-29 — fileio size is FIXED at creation.** `truncate -s 1G` on the backing file changed
nothing: `info` still reported `size: 536870912`, configfs still `Size: 536870912`, the
initiator still 512 MiB after a rescan. There is no resize command in the fileio backstore's
command set. The only path is **delete LUN → delete backstore → recreate with `wwn=` →
re-map the LUN → rescan**; done that way the initiator kept the same serial and saw 1 GiB.
Also note: **`size=` is ignored when the file already exists** —
`/gtiscsi/images/lun2.raw exists, using its size (536870912 bytes) instead`. The file's
length is the LUN's size, so growing a fileio LUN means growing the file *first*.

**GT-30 — UNMAP works, and the two kinds need different settings.**
Baseline with `emulate_tpu=0`: `provisioning_mode=full`, `discard_max_bytes=0`, VPD 0xb2
`LBPU=0`, and `blkdiscard` fails `Operation not supported`.

- **block/zvol**: `emulate_tpu=1 emulate_tpws=1` + `--rescan` →
  `provisioning_mode=writesame_16`, `discard_granularity=16384`. `blkdiscard /dev/sdb`
  returned the zvol from `REFER 515M` to `REFER 12K`. **Works out of the box.**
- **fileio**: with the same settings Linux also picks `writesame_16`, and LIO **rejects it**:
  `Sense Key : Illegal Request … Add. Sense: Invalid field in cdb … CDB: Write same(16) 93 08 …`
  → `blkdiscard: BLKDISCARD: /dev/sdc ioctl failed: Remote I/O error`.
  Real UNMAP (CDB 0x42) works, but the default `max_unmap_lba_count=8192` (4 MiB) makes a
  whole-device discard fail with `Invalid field in parameter list`. With
  `max_unmap_lba_count` raised and the initiator forced to `provisioning_mode=unmap`, the
  1 GiB image file went from 256 MiB allocated to **512 bytes** and the dataset's `used`
  from 256 M to 24 K.

  Conclusion: `emulate_tpu=1` plus a raised `max_unmap_lba_count` is the correct target-side
  configuration for fileio; **whether a given initiator gets reclaim depends on which SCSI
  command it chooses**, and Linux's default choice (WRITE SAME 16 + UNMAP) does not work
  against LIO fileio. This must not be promised in the UI as "thin".

- A non-sparse (thick) zvol never shows reclaim in `zfs list USED` (the refreservation
  holds it); only `referenced` moves. If ANAS wants visible thin behaviour on ZFS it must
  create the zvol **sparse** (`zfs create -s -V`).

### Auth and ACLs

**GT-31 — TPG defaults after `create`** (`fixtures/iscsi/tpg-attrs-params-auth.txt`):

```
authentication=0        generate_node_acls=0     cache_dynamic_acls=0
demo_mode_write_protect=1   demo_mode_discovery=1   prod_mode_write_protect=0
tpg_enabled_sendtargets=1   login_timeout=15        default_cmdsn_depth=64
AuthMethod=CHAP,None    TargetAlias=LIO Target   MaxRecvDataSegmentLength=8192
```

LIO's demo mode is **off by default** (`generate_node_acls=0`), which is what the epic
wants — nothing to disable. But `demo_mode_discovery=1` means **SendTargets discovery is
open to anyone who can reach 3260**: a non-ACLed initiator successfully enumerated the
target IQN and every portal before being refused at login. `/iscsi get discovery_auth`
shows `enable=False`, `enforce_discovery_auth=0` — discovery CHAP exists and is unused.

**GT-32 — with explicit ACLs, CHAP lives on the ACL, not the TPG.** Setting
`authentication=1` flips the `targetcli ls` label to `auth per-acl`, and the TPG-level
`userid`/`password` are ignored: a login with no per-ACL credentials was refused even
though the TPG carried a valid pair. Credentials are per-ACL
(`acls/<iqn>/auth/{userid,password,userid_mutual,password_mutual,authenticate_target}`);
setting `mutual_password` flips `authenticate_target` to 1 automatically.

**GT-33 — verbatim rejection texts** (all in `fixtures/iscsi/error-texts.txt`):

| case | initiator | exit | target-side kernel journal |
|---|---|---|---|
| not in the ACL | `iscsiadm: initiator reported error (24 - iSCSI login failed due to authorization failure)` | 24 | `iSCSI Initiator Node: <iqn> is not authorized to access iSCSI target portal group: 1.` |
| CHAP enforced, no credentials | same, error 24 | 24 | `Initiator is requesting CSG: 1, has not been successfully authenticated, and the Target is enforcing iSCSI Authentication, login failed.` |
| wrong CHAP secret | same, error 24 | 24 | only `iSCSI Login negotiation failed.` — **indistinguishable from "not in the ACL" at the default log level** |
| wrong **mutual** secret | `iscsiadm: initiator reported error (19 - encountered non-retryable iSCSI login failure)` | **19** | (initiator-side rejection; nothing distinctive target-side) |
| TPG disabled | `iscsiadm: initiator reported error (8 - connection timed out)`; discovery → `iscsiadm: No portals found` (exit 21) | 8 / 21 | — |

**GT-34 — LIO validates CHAP secret length not at all.** 1, 7, 8, 12, 16 and 20-character
secrets were all accepted by `targetcli` and written to configfs verbatim. The 12–16-byte
Windows rule is a *client* rule; if ANAS wants it enforced it must do it in the Zod schema.

**GT-35 — secrets are plaintext in three places, and targetcli puts them on argv.**

> **Amendment (iscsi.4 build, 2026-08-25):** LIO's kernel auth store treats the literal string `NULL` as "clear this credential"; a zero-length write stores an EMPTY credential and marks it SET. Clearing therefore writes `NULL`, and the read layer treats `NULL` as unset (`credentialsSet:false`) — the iscsi.2 parser/configfs reader originally reported a cleared secret as set; fixed in iscsi.4.

`.../auth/password` in configfs and `chap_password` in `saveconfig.json` are readable
plaintext (both root-only), and `targetcli "/iscsi/…/acls/… set auth password=X"` puts the
secret in the process command line. **A direct configfs write avoids argv entirely and is
picked up by both targetcli and `saveconfig`** — proven:

```
printf '%s' 'secret' > /sys/kernel/config/target/iscsi/<IQN>/tpgt_1/acls/<init>/auth/password
targetcli "… get auth"   → password=secret
targetcli saveconfig     → "chap_password": "secret"
```

This is the path that satisfies the standing "secrets never in argv" ruling.

**GT-36 — deleting an ACL kills its session instantly, silently.** With a live session,
`acls delete <iqn>` returned exit 0, `targetcli sessions list` immediately reported
`(no open sessions)` — and the initiator's `/dev/sdb`, `/dev/sdc` **remained as stale
devices**. Recreating the ACL also **loses its CHAP credentials** (they are ACL-scoped).

**GT-37 — `tpg disable` refuses new logins but the portal socket stays.** After
`disable`: `enable=0`, discovery returns `iscsiadm: No portals found` (exit 21), a new login
times out (error 8), yet `ss -lnt` still shows the 3260 listener. Re-`enable` restores
service.

### Sessions

**GT-38 — `dynamic_sessions` is the WRONG file for explicit ACLs.**
`.../tpgt_1/dynamic_sessions` is **empty** — it only lists sessions of dynamically
generated ACLs (`generate_node_acls=1`, which ANAS never uses). The authoritative
per-initiator source is `.../acls/<initiator IQN>/info`:

```
InitiatorName: iqn.1993-08.org.debian:01:ae3d2ec18ad
InitiatorAlias: anas-pve
LIO Session ID: 1   ISID: 0x00 02 3d 00 00 02  TSIH: 1  SessionType: Normal
Session State: TARG_SESS_STATE_LOGGED_IN
---------------------[iSCSI Session Values]-----------------------
  CmdSN/WR  :  CmdSN/WC  :  ExpCmdSN  :  MaxCmdSN  :     ITT    :     TTT
 0x00000040   0x00000040   0x000000e2   0x00000121   0x00000069   0x000000df
----------------------[iSCSI Connections]-------------------------
CID: 0  Connection State: TARG_CONN_STATE_LOGGED_IN
   Address 192.168.200.50 TCP  StatSN: 0x6916c3e9
```

and, with no session, the single line
`No active iSCSI Session for Initiator Endpoint: <iqn>`.
`targetcli ls` shows **no session information at all**; `targetcli sessions detail` is the
only CLI view and it is free-form text:

```
alias: anas-pve	sid: 5 type: Normal session-state: LOGGED_IN
    name: iqn.1993-08.org.debian:01:ae3d2ec18ad (authenticated)
    mapped-lun: 0 backstore: block/gtiscsi_vol1 mode: rw
    address: 192.168.200.50 (TCP)  cid: 0 connection-state: LOGGED_IN
```

**GT-39 — `(NOT AUTHENTICATED)` in `sessions detail` does NOT mean "no CHAP".** A session
authenticated with one-way CHAP still printed `(NOT AUTHENTICATED)`; the label flipped to
`(authenticated)` only once **mutual** CHAP was in play. It reflects
`authenticate_target`, not whether the initiator authenticated. Do not surface it verbatim.

### Cross-feature collisions

**GT-40 — ZFS refuses destroy and export, and nothing else.**

| operation, with a LUN mapped to the object | result |
|---|---|
| `zpool export gtiscsi` (fileio file open) | `cannot unmount '/gtiscsi/images': pool or dataset is busy` — exit 1 |
| `zfs destroy gtiscsi/vol1` | `cannot destroy 'gtiscsi/vol1': dataset is busy` — exit 1 |
| `zfs destroy gtiscsi/images` | `cannot unmount '/gtiscsi/images': pool or dataset is busy` — exit 1 |
| **`zfs rollback gtiscsi/vol1@snap`** | **exit 0** — succeeded with a live session *and* a mounted filesystem on the initiator |
| **`zfs rename gtiscsi/vol1 gtiscsi/vol1x`** | **exit 0** — the LUN keeps serving from the open bdev, `udev_path` is now a dangling path, and the next boot restore silently drops the LUN |
| **`zfs set volsize=1G` (shrink from 2G)** | **exit 0** — silent truncation under a live LUN |
| `zfs destroy gtiscsi/vol1@snap` | exit 0 — destroying a *snapshot* of a live zvol is allowed |
| **`rm /gtiscsi/images/lun2.raw`** | **exit 0** — LIO keeps serving the unlinked inode; the data dies when the backstore is deleted |

The refusals are all-or-nothing and identical whether or not an initiator is connected —
LIO holds the backing object because the **backstore** exists, not because a session does.

**GT-41 — nothing in userspace names LIO as the holder.**

```
fuser -m /dev/zd0        → exit 1, no output
fuser -m /gtiscsi/images → exit 1, no output
lsof /dev/zd0            → no rows
/sys/block/zd0/holders/  → empty
```

The claim is visible **only** in configfs:

```
Status: ACTIVATED  Max Queue Depth: 128  SectorSize: 512  HwMaxSectors: 32768
        iBlock device: zd0  UDEV PATH: /dev/zvol/gtiscsi/vol1  readonly: 0
  exclusive: 1
        Major: 230 Minor: 0  CLAIMED: IBLOCK
```

`busy-diagnosis.ts` cannot find LIO with its existing process-based tools; it needs a
configfs source (`core/*/*/udev_path`, plus each `iscsi/*/tpgt_*/lun/lun_*/` symlink target
to name the target and LUN number).

**GT-42 — LUN and backstore deletion are NOT gated by a live session.**
`luns delete lun1` and `backstores/fileio delete gtiscsi_lun2` both returned exit 0 with a
live session; the initiator kept a stale 512 MiB `/dev/sdc` and produced *no kernel message*
until the next rescan. Every session gate for `iscsi.6` has to be ANAS's own.

### Disk inventory

**GT-43 — today's `/v1/disks` offers a zvol and an iSCSI LUN as composer candidates.**
Live capture from anasd 0.2.11 on the node (`fixtures/iscsi/anasd-v1-disks.json`):

```json
{"id":"zd16","name":"zd16","path":"/dev/zd16","size":536870912,…,"status":"available"}
{"id":"scsi-36001405689844a41d204cba8516bdc52","name":"sdc","transport":"iscsi",
 "model":"gtiscsi_lun2","vendor":"LIO-ORG",…,"status":"available"}
```

A blank zvol reports `status: available`, and so does a LUN **served by this very node**
when its own initiator is logged in — a loop-back hazard the story does not mention.
The seam is one filter in `packages/daemon/src/parsers/lsblk.ts`:

```ts
.filter(dev => dev.type === 'disk' && !dev.name.startsWith('zram') && !dev.name.startsWith('loop'))
```

`loop` and `zram` are already excluded (loop devices never reached `/v1/disks` in the
capture); `zd*` and `tran === 'iscsi'` are not. `lsblk` already reports `TRAN=iscsi` and
`HCTL` for LUNs, and anasd already carries `transport` through, so the fix has all the data
it needs.

### PVE as a consumer

**GT-44 — PVE's stock plugin consumes an ANAS target with zero ANAS involvement.**

```
# pvesm add iscsi gtiscsi-pve --portal 192.168.200.50 --target iqn.2026-08.dev.anas.gtiscsi:target1 --content none
…
Login to [iface: default, target: iqn.2026-08.dev.anas.gtiscsi:target1, portal: 192.168.200.50,3260] successful.

# pvesm status
gtiscsi-pve       iscsi     active               0               0               0    0.00%

# pvesm list gtiscsi-pve
Volid                                                    Format  Type            Size VMID
gtiscsi-pve:0.0.0.scsi-360014059bc6e90760154267be4f5a061 raw     images    2147483648
gtiscsi-pve:0.0.1.scsi-36001405689844a41d204cba8516bdc52 raw     images    1073741824
```

`storage.cfg` gains exactly `portal` / `target` / `content` — no CHAP field exists in the
`iscsi:` plugin, so a CHAP-protected target requires hand-editing `/etc/iscsi/iscsid.conf`
on every PVE node. **`iscsi.7` must run its PVE-consumes-it leg with CHAP off, or say so.**

**GT-45 — a PVE volid embeds the unit serial.** `gtiscsi-pve:0.0.0.scsi-3<naa>` — host,
bus, LUN and the by-id name. If a LUN's serial changes, **every PVE VM disk referencing it
breaks**. This is a harder, closer-to-home reason for `iscsi.2`'s serial-persistence
requirement than Windows or ESXi.

**GT-46 — `pvesm remove` leaves the session and the node record behind.** After removal,
`iscsiadm -m session` still showed the session and `iscsiadm -m node` still listed the
record. ANAS's "connected initiators" view will keep showing a PVE session long after the
storage entry is gone; that is correct and should not be explained away.

---

## Design impacts — answering the ⚠ notes

### `iscsi.2` (schemas + read layer)

- ⚠ **"Serial persistence is designed in here"** — **confirmed and stronger than stated.**
  GT-16/GT-17: `wwn` is a *create-only* parameter with no validation; GT-18: attributes are
  lost on every recreate too, so the replay contract is `{serial, attributes}`, not
  `{serial}`. GT-19: boot restore replays it for free — the three paths that must replay it
  explicitly are **fileio resize** (GT-29), **image restore** (`backup2.7`) and any
  **repair/recreate** ANAS offers. GT-45 adds PVE volids to the list of things that break.
- **Ownership without shadow state** — the facts support the plan: `saveconfig.json` gives
  `dev` (the backing path) and `name` for every storage object, so "backing path is under an
  ANAS-managed pool/dataset" is decidable from existing inventory. Add one caveat from
  GT-40: `dev` **can go stale** (a `zfs rename` under a live LUN leaves a dangling
  `udev_path`), so the read layer must report a LUN whose backing path does not resolve as
  *broken*, not as *foreign*.
- **Parsing** — GT-12 and GT-13 are the trap list: bracketed IPv6, throwaway `alias`
  strings, the indexed `core/<plugin>_<n>/` directory, the `T10 VPD Unit Serial Number: `
  prefix, and `attributes{}` sets that differ between views.
- **Sessions** — GT-38: `dynamic_sessions` is empty under the design ANAS is choosing.
  Read `acls/<iqn>/info`. GT-39: do not surface `(NOT AUTHENTICATED)`.

### `iscsi.3` (zvols in Datasets)

- Nothing contradicted. Two facts to carry: a thick zvol never shows reclaim in `used`
  (GT-30), so the create dialog's sparse option is what makes "thin" meaningful; and
  **`zfs rename`, `zfs rollback` and a `volsize` shrink are all permitted under a live LUN**
  (GT-40) — the Datasets verbs need the same `iscsi.6` cross-check as destroy, which the
  story currently only implies.

### `iscsi.4` (the iSCSI menu)

- ⚠ **"`targetcli` is not transactional; serialize behind a mutex"** — **confirmed, and
  worse than stated.** GT-5: stdin batching hides failures behind exit 0 *and* auto-saves
  the half-applied state. **One `targetcli "<cmd>"` per invocation, exit code checked, is
  the only safe form**; at 0.1–0.4 s (GT-6) there is no cost argument for anything else.
- ⚠ **"`saveconfig` is copied before every mutation (rotating, in ANAS's own dir)"** —
  **partly redundant.** GT-9: targetcli already keeps 10 rotating gzipped copies in
  `/etc/rtslib-fb-target/backup/` on every save, and `targetcli saveconfig <path>` writes an
  arbitrary file in one command. Per "don't build undifferentiated code", ANAS should lean
  on LIO's own rotation (and read `max_backup_files`) rather than build a second rotator.
  What ANAS *does* need is GT-22's guard: **never `saveconfig` when the live config is known
  to be an incomplete restore.**
- ⚠ **"Backstore names are flat: `pool/vol` needs a collision-free encoding"** — confirmed,
  **and the encoding is user-visible**: GT-15, the backstore name is the SCSI model string
  (16 chars in INQUIRY) and part of the VPD 0x83 T10 designator. Pick something a person
  reading `lsblk MODEL` on the initiator can recognise, and treat a rename as identity-
  changing (there is no rename anyway — GT-10).
- ⚠ **"Sensible attribute defaults: `emulate_tpu`/`tpws` on … `write_thru` for fileio"** —
  confirmed as *changes*, not confirmations: GT-26 ships **tpu/tpws off on both kinds** and
  **write-back ON for fileio**. Add `max_unmap_lba_count` to the list ANAS sets (GT-30) —
  the fileio default of 8192 (4 MiB) makes whole-device discards fail outright. And GT-30's
  honest caveat belongs in the UI: fileio thin reclaim depends on the initiator's command
  choice, and Linux's default choice does not work.
- ⚠ **"CHAP secret length validated in the schema"** — confirmed necessary: GT-34, LIO
  accepts a 1-character secret.
- **New, not in the story:** GT-8 — `auto_add_default_portal=true` creates a `0.0.0.0:3260`
  portal on target create, which contradicts the epic's threat model. ANAS must delete any
  unrequested `0.0.0.0` portal after create (and must not *assume* one was created — on a
  second target it is skipped).
- **New:** GT-35 — the standing "secrets never in argv" ruling **rules out the obvious
  `targetcli set auth` call**. Write the four `auth/*` files in configfs directly, then
  `saveconfig`. Proven to work and to round-trip.
- **New:** GT-27 — `block_size` must be set before the backstore is mapped; a
  block-size choice is create-time only.
- **New:** GT-36 — deleting an ACL drops its session instantly and destroys its CHAP
  credentials. ACL edits are session-affecting mutations, not metadata edits.

### `iscsi.5` (boot, lifecycle, gates)

- ⚠ **"the A1 review finding; seam = `zfs-import-unit.ts`"** — **confirmed and materially
  worse.** GT-20/GT-21: the restore does not merely lose the LUN, it reports **success**;
  the target comes up enabled and listening with a hole in it, or with **zero LUNs** if the
  whole pool is late, and an initiator logs in happily and sees nothing. The upstream cause
  is `targetctl`'s own `for error in errors: print(error)` with no exit code (GT-20), so no
  amount of systemd `Restart=`/`OnFailure=` will catch it — **the drop-in must prevent the
  race, and ANAS must detect the hole itself** by comparing `saveconfig.json` against live
  configfs (a `saveconfig` LUN with no matching configfs object = a missing-backing warning).
  Journal matching is the secondary signal; the two texts are in GT-21.
- **"modules loaded on first use only"** — **not achievable as written** (GT-4). rtslib
  loads every backstore plugin, including `target_core_pscsi` and `target_core_user`, on
  the first real targetcli invocation. The honest form of this requirement is "ANAS does not
  load target modules itself; the package's service does, and only when a config exists".
- **Ordering** — GT-3 / GT-3b: the shipped unit has no ZFS/AHR ordering of its own, but
  `After=local-fs.target` already gets it *after* `zfs-mount.service` transitively, so a
  **fileio LUN on a dataset is usually fine**; a **zvol LUN is not**, because nothing in
  that chain waits for `/dev/zvol/*`. The drop-in needs
  `Wants=zfs-volumes.target` + `After=zfs-volumes.target zfs-mount.service` (which also
  covers `zfs-import@<pool>.service`, the unit `zfs-import-unit.ts` already enables per
  pool), plus the AHR activation unit — **and** a `Before=` at shutdown so
  `ExecStop=targetctl clear` runs before pools go away, otherwise `zpool export` at
  shutdown hits GT-40's `dataset is busy`.
- **New:** GT-22 — the boot-warning path must *also* block ANAS from saving over the
  truncated config.
- **New:** GT-47 — a real reboot on this node restored cleanly with a 1.23 s margin, but
  that margin is coincidence (270 ms file-vdev imports), not ordering. Do not read the
  green reboot as "the race is not real"; `iscsi.7` must re-run it on disks.
- **New:** GT-48 — `/dev/zdN` numbers move across a reboot. LIO is safe only because
  `saveconfig.json` stores `/dev/zvol/<pool>/<vol>`; ANAS must never persist or match a
  `zdN` name (and `/v1/disks` currently uses one as a zvol's `id`).

### `iscsi.6` (the rest of ANAS knows a LUN is there)

- **"refused with 'held by LUN …'"** — the *destroy/export* half is already enforced by ZFS
  (GT-40) and ANAS only needs to turn `dataset is busy` into a useful message. **The
  dangerous half is what ZFS does NOT refuse**: `zfs rollback`, `zfs rename` and a
  **`volsize` shrink** all succeed silently under a live LUN with a mounted filesystem on
  the initiator, and `rm` of a fileio backing file succeeds too. The story names rollback;
  **rename and shrink must be added**, and `rm`-equivalents (dataset destroy of the parent
  is covered; a file delete through any future path is not).
- ⚠ **"`busy-diagnosis.ts` names LIO"** — GT-41: `fuser`, `lsof` and `holders/` find
  **nothing**. The diagnosis must read configfs. Fail-open still applies.
- **"a zvol snapshot rollback under a live session is refused outright"** — correct, and
  note GT-40: destroying a *snapshot* of a live zvol is allowed by ZFS, which is fine.
- **"a portal whose address is gone shows in status"** — GT-24: **LIO will never tell you.**
  A portal binds to a non-existent address, reports `[OK]`, and survives interface deletion
  and a service restart without a single log line. ANAS must diff configured portal
  addresses against the node's own addresses.
- **"deleting/resizing a LUN with a live session is a 409"** — GT-42: LIO offers **no**
  protection at all (exit 0, stale device on the initiator, no kernel message). ANAS's gate
  is the only one.
- **"the disk inventory excludes `/dev/zd*` and loop devices from composer candidates"** —
  GT-43: loop devices are **already** excluded; `zd*` is **not**, and a blank zvol currently
  reports `status: available`. Add to the story: **an iSCSI LUN served by this node and
  logged in locally also reports `available`** — filter on `transport === 'iscsi'` too.
- **"a PVE firewall that would block 3260 is warned about"** — untested (see Open questions).

### `iscsi.7` (live-proof)

- Plan against GT-44/GT-45/GT-46: the PVE leg needs CHAP **off** (the `iscsi:` plugin has no
  CHAP field), the volid check is the serial-persistence proof, and `pvesm remove` will
  leave a session behind that must be cleaned up explicitly.
- The reboot leg needs a disk-backed pool, not a file vdev.

---

## Open questions

1. **Windows and ESXi initiators — untested.** No Windows VM was available on the stunt
   node. Unverified: the 12–16-byte CHAP secret rule (GT-34 shows the *target* does not
   enforce it), whether Windows re-signatures a disk when the serial changes (GT-17 proves
   only the Linux/PVE side), MPIO behaviour with multiple portals, and `emulate_pr`
   (SCSI-3 persistent reservations, default on) under a Windows cluster.
2. **fileio thin reclaim per initiator.** GT-30 shows Linux's default WRITE SAME(16)+UNMAP
   path is rejected by LIO fileio. Do Windows and ESXi issue real UNMAP (and therefore
   reclaim), and what `max_unmap_lba_count` should ANAS set? Untested.
3. **The boot ordering race was not reproduced, only reasoned about.** A real reboot was
   performed (GT-47) and it succeeded — but with two file-vdev pools importing in 270 ms
   and a 1.23 s margin, it could not *lose* the race. What is still unproven: the same boot
   on a node with real disks (import measured in seconds), an AHR pool's activation timing,
   and **shutdown** ordering — whether `ExecStop=targetctl clear` runs before pool export,
   or whether export hits GT-40's `dataset is busy`. `iscsi.7` must cover both on a
   disk-backed pool.
4. **AHR-backed fileio untested.** All fileio work was on a ZFS dataset. A file on btrfs is
   AHR's only block object; the sparse/hole-punch behaviour behind GT-30 needs re-proving
   on btrfs before the AHR path is promised.
5. **`iscsi.6`'s firewall warning** — PVE firewall interaction with port 3260 was not
   exercised; the node's firewall was not enabled.
6. **Multiple TPGs / multiple targets** — only one target with one TPG was built. GT-8's
   conditional auto-portal behaviour was observed on a second target but a full multi-target
   layout (portal sharing rules, `tag` numbering) was not.
7. **`emulate_pr` / `force_pr_aptpl`** — SCSI reservations are on by default and their
   state lives in configfs `pr/res_aptpl_metadata`. Whether saveconfig round-trips
   reservations, and what a LUN delete does to a reserving initiator, is unexplored.
8. **`aio` and `sparse` fileio create flags** — `aio: False` was the default throughout and
   the `sparse` create parameter was not exercised (the backing file was pre-created, which
   makes `size=` a no-op per GT-29).
9. **iSER / offload** — `iser: false`, `offload: false` appear in every portal record; not
   investigated.
