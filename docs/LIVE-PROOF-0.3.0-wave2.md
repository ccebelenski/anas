# Live proof — 0.3.0 wave 2 (`iscsi.7`, and the live proof `iscsi.4`–`iscsi.6` and `backup2.3`–`backup2.7` owed)

Driven 2026-08-26 against the disposable stunt PVE 9 node `anas-pve` (192.168.200.50) from
`main` @ `c37a5c7`, deployed with `test/stunt-node/deploy-anas.sh` and redeployed after each
fix. Every call below went to the REAL daemon on its unix socket (`/run/anas/anasd.sock`,
identity headers `x-anas-user` / `x-anas-user-uid` / `x-anas-request-id`, confirm retries via
`x-anas-confirm`), with a sample repeated through the gateway
(`https://…:8006/anas/api/nodes/anas-pve/v1/…` with a PVE ticket) to prove the transport.
Answers were compared against the system's own truth — `targetcli ls`, configfs,
`saveconfig.json`, `zfs get`, `btrfs subvolume list`, `findmnt`, `lsblk -S`, `iscsiadm`,
`dmesg`, `systemctl show`, `journalctl`, `catalog shell` / `catalog dump`, `pvesm` — never
against fixtures.

Snapshots: **`pre-wave2-liveproof`** before anything, **`post-wave2-liveproof`** at the end.
Two real reboots were part of the proof, plus one enabled-then-disabled `pve-firewall`.

## Verdicts

| # | Area | Verdict | Note |
|---|---|---|---|
| **A** | `iscsi.7` arc, end to end | **PASS** after two fixes | the IQN, the security defaults, both LUN kinds, CHAP one-way + mutual, ACL rejection, PVE consumption, growth, every refusal, the reboot, the hole and the repair. **F1** blocked LUN-add and Repair outright until fixed |
| **B** | `iscsi.5` / `iscsi.6` remainder | **PASS**, with one HIGH finding | shutdown ordering proven from the journal; AHR-backed fileio works and survives a reboot; the firewall advisory proven in all four states. **F2** is worse than the known AHR gap and is NOT fixed |
| **C** | `backup2.3` AHR nested subvolume | **PASS** after a fix | per-subvolume transients, held-open top-level, `__photos` expansion, all destroyed. **F4** fixed; the wave-1 F3 sidestep confirmed; `--include-dev` under a `.zfs/snapshot` root settled |
| **D** | `backup2.4` image archives | **PASS**, with one finding | zvol snapdev cycle and AHR image file both end to end; `lun-sources` correct against the real target except **F7** |
| **E** | `backup2.5` owed proofs | **PASS** | the cross-directory hardlink form is settled; `Modify:` timezone measured |
| **F** | `backup2.6` restores | **PASS** after a fix, one item NOT-POSSIBLE | every mode driven for real. **F6** fixed. `missing[]` is unreachable from the API (the pre-flight refuses first) |
| **G** | `backup2.7` image restore | **PASS** after a fix | **F3: the feature did not work at all.** After the fix: zvol and AHR branches, whole-target offline, partial path, `--rate`, serial/attribute read-back |
| **H** | Wave-1 regression | **PASS** | `iscsi.2` reads (200/400/404), gateway transport, volumes create/grow/shrink-refuse/gate/snapshot/destroy, nested none/all/paths |

Suite at the end: **2726** daemon + **46** gateway tests, **600** dialog-contract + mounts +
**90** edit-guard UI checks — all green; typecheck and lint clean.

Six fixes landed, each with a regression test:

| Commit | What |
|---|---|
| `6185bb6` | adding a LUN to a target with ACLs no longer fails the job (**F1**, and the same bug in Repair) |
| `3af3aee` | the held-by-LUN refusal stops blaming ZFS on non-ZFS objects (**F10**) |
| `9207a04` | a snapshot-mode run stops warning about boundaries it covered (**F4**) |
| `9b92479` | Run-Now reports the snapshot facts the unit already recorded (**F5**) |
| `2cc6b28` | a cross-directory hardlink's partner is found, so the restore runs (**F6**) |
| `200eac0` | LUN image restore works at all — the client opens `/dev/stdout` by path (**F3**) |

---

## A. The `iscsi.7` arc

### A.1 Create a target through the API

```
POST /v1/iscsi/targets
  {"name":"lp2","portals":[{"address":"192.168.200.50","port":3260}],"auth":"none",
   "acls":[{"initiatorIqn":"iqn.1993-08.org.debian:01:ae3d2ec18ad"},
           {"initiatorIqn":"iqn.1993-08.org.debian:01:deadbeefcafe"}]}   → 202
job result: {"iqn":"iqn.2026-08.anas-pve.anas:lp2","portals":1,"acls":2,
             "removedDefaultPortal":false,"warnings":[]}
```

The IQN came out `iqn.<yyyy-mm>.<node authority>.anas:<name>` exactly — `anas-pve.anas` is
the reversed hostname plus `anas`, the two-label form live-proof wave 1's **F1** forced.

System truth immediately after:

```
$ T=/sys/kernel/config/target/iscsi/iqn.2026-08.anas-pve.anas:lp2/tpgt_1
$ ls $T/np                     192.168.200.50:3260        ← the node's address, and ONLY it
$ cat $T/attrib/demo_mode_discovery   0
$ cat $T/attrib/generate_node_acls    0
$ targetcli ls …               o- tpg1 … [no-gen-acls, no-auth]
```

**No `0.0.0.0:3260` portal exists** — and `removedDefaultPortal:false` says ANAS did not have
to remove one, because LIO declined to create it (GT-8 is conditional, wave-1 O6). The build
verifies by read-back rather than assuming, which is the point.

### A.2 The two LUN kinds — and F1

The first two `POST …/luns` calls **both failed**:

```
job result: failed
  targetcli /iscsi/iqn.2026-08.anas-pve.anas:lp2/tpg1/acls/iqn.1993-08.org.debian:01:ae3d2ec18ad
            create 0 0 failed: This MappedLUN already exists in configFS
```

…while `targetcli ls` showed the LUN present, mapped into both ACLs, and correct. See
**F1**. After the fix:

```
lun0: completed {"index":0,"name":"lpzvol","serial":"3183e69f-7924-442a-9cde-2a1362d6a949",
                 "backingPath":"/dev/zvol/gtbackup/sparse1",
                 "attributes":{"emulateTpu":true,"emulateTpws":true,
                               "maxUnmapLbaCount":524288,"writeBack":false,"blockSize":512}}
lun1: completed {"index":1,"name":"lpfile","serial":"2e69b404-d086-4ca6-bf9b-57455c97e585",
                 "backingPath":"/gtbackup/images/lpfile.raw", … "maxUnmapLbaCount":262144 …}
      warnings: ["Thin reclaim is enabled on the target side, but an image-file LUN only
                 reclaims when the initiator issues a real UNMAP: Linux's default choice
                 (WRITE SAME 16) is rejected by LIO for this backend …"]
```

Read back against configfs, field by field:

```
core/iblock_2/lpzvol/wwn/vpd_unit_serial : T10 VPD Unit Serial Number: 3183e69f-…
core/iblock_2/lpzvol/udev_path           : /dev/zvol/gtbackup/sparse1      ← never zd*
core/iblock_2/lpzvol/attrib/             : emulate_tpu=1 emulate_tpws=1 block_size=512
                                           max_unmap_lba_count=524288 emulate_write_cache=0
core/fileio_3/lpfile/info                : … Size: 1073741824  Mode: O_DSYNC Async: 0
core/fileio_3/lpfile/attrib/             : emulate_tpu=1 emulate_tpws=1 block_size=512
                                           max_unmap_lba_count=262144 emulate_write_cache=0
```

`Mode: O_DSYNC` is `write_back=0` on the wire. The API's `GET /v1/iscsi/targets/:iqn` reported
every one of those values identically, plus `ownership: anas`, `ownershipReason: anas-managed`,
`"IQN follows the ANAS naming convention and all 2 LUNs are backed by ANAS-managed storage"`.

### A.3 Login, CHAP, and the unlisted initiator

```
$ iscsiadm -m discovery -t sendtargets -p 192.168.200.50
192.168.200.50:3260,1 iqn.2026-08.dev.anas.gtiscsi:target1
192.168.200.50:3260,1 iqn.2026-08.anas-pve.anas:lp2
$ iscsiadm -m node -T iqn.2026-08.anas-pve.anas:lp2 -p 192.168.200.50 --login
Login to […] successful.
$ lsblk -S -o NAME,VENDOR,MODEL,SERIAL
sdb  LIO-ORG  lpzvol  3183e69f-7924-442a-9cde-2a1362d6a949
sdc  LIO-ORG  lpfile  2e69b404-d086-4ca6-bf9b-57455c97e585
```

The backstore name IS the SCSI model string the initiator sees, and the serial ANAS generated
is the serial the initiator pins. `GET /v1/iscsi/sessions` showed the session with
`mappedLuns [0,1]` and `state TARG_SESS_STATE_LOGGED_IN`, read from `acls/<iqn>/info`.

**One-way CHAP.** `PUT …{"auth":"chap", acls:[…]}` with one ACL left credential-less is a
`400` before anything is written:

```
Initiator iqn.1993-08.org.debian:01:deadbeefcafe would never be able to log in:
CHAP needs a username and a secret on every initiator ACL — under explicit ACLs LIO
ignores TPG-level credentials entirely
```

With both ACLs complete the job completed (`credentialsUpdated: 2`, `authChanged: true`),
`attrib/authentication` went `0 → 1`, both `auth/userid` files carried the userids and both
`auth/password` files were non-empty. **No secret appeared in any journald line, any job
result, any progress string or any argv** — the audit lines record `{"auth":"chap","acls":2}`
and nothing more. Then:

```
$ iscsiadm … --login          (initiator has NO chap configured)
iscsiadm: initiator reported error (24 - iSCSI login failed due to authorization failure)
$ iscsiadm … -n node.session.auth.{authmethod,username,password} …; iscsiadm … --login
Login to […] successful.
```

**Mutual CHAP.** `PUT … {"auth":"mutual-chap", …}` → `authenticate_target` flips to `1` by
itself (GT-32; ANAS never writes that flag). Login with the correct `password_in` succeeds;
with a WRONG one:

```
iscsiadm: initiator reported error (19 - encountered non-retryable iSCSI login failure)
```

— so the target really does present its own credentials and the initiator really validates
them. See the GT amendment about what `authenticate_target=1` does *not* do.

**An unlisted initiator** (a second `iscsiadm` iface with a different InitiatorName):

```
$ iscsiadm -m discovery -t sendtargets -p 192.168.200.50 -I lpbogus
192.168.200.50:3260,1 iqn.2026-08.dev.anas.gtiscsi:target1        ← lp2 is NOT listed
$ iscsiadm -m node -T …:lp2 -I lpbogus --login       (with VALID CHAP credentials)
iscsiadm: initiator reported error (24 - iSCSI login failed due to authorization failure)
$ dmesg | tail
iSCSI Initiator Node: iqn.1993-08.org.debian:01:notallowed99 is not authorized to access
iSCSI target portal group: 1.
iSCSI Login negotiation failed.
```

Both halves of the threat model hold: `demo_mode_discovery=0` hides the target from an
initiator with no ACL, and `generate_node_acls=0` refuses the login even with good CHAP.

### A.4 PVE consumes it — the serial is the volid

With `auth` back to `none` (the `iscsi:` plugin has no CHAP field; the stored ACL credentials
were kept, per the omitted-means-keep contract):

```
$ pvesm add iscsi liveproof --portal 192.168.200.50 --target iqn.2026-08.anas-pve.anas:lp2 --content images
Login to […] successful.
$ pvesm list liveproof
Volid                                                  Format  Type            Size VMID
liveproof:0.0.0.scsi-360014053183e69f7924442a9cde2a136 raw     images     536870912
liveproof:0.0.1.scsi-360014052e69b404d0864ca6bf9b57455 raw     images    1073741824
```

`3183e69f7924442a9cde2a136` is the first 25 hex characters of LUN 0's serial, `36001405` is
LIO's NAA prefix — **the volid IS the serial**, which is the whole reason `iscsi.2` replays
`wwn=` on every recreate. `pvesm remove liveproof` deleted the storage and, exactly as GT-46
says, **left the session behind**; `GET /v1/iscsi/sessions` still listed it.

While that session was up, `GET /v1/disks` tagged both served LUNs:

```
scsi-360014053183e69f7924442a9cde2a136  iscsi  handsOff: iscsi-served-here
  "This disk is an iSCSI LUN served by THIS node (backstore 'lpzvol') — the node's own
   initiator is logged in to its own target. It is not remote storage: building a pool on it
   would stack storage on top of itself. Manage it from the iSCSI screen."
```

and no `zd*` device appeared in the inventory at all (`iscsi.6`, both halves).

### A.5 Data, growth, identity

Written from the initiator: `mkfs.ext4 -L LPZVOL` + `marker.txt` + a 64 MiB random
`payload.bin` on the zvol LUN; a recognisable head sector, 63 MiB of random and a tail sector
on the file LUN.

```
sha256(/mnt/lpzvol/payload.bin)      de93cda9f74b01278b28b4780ada2306efe9009d2f26523b053c4398bae042ad
sha256(first 64 MiB of the file LUN) 0fe7497c6ab38973faca37ce34ee88bc2351f53adc0a10c30a36d029e001ecdd
sha256(file LUN tail sector)         b306cfc41e7fbb04809527ad509142c08d82ce1e97a33babb3479368435bc26f
```

**Growth.** A resize under a live session is refused outright, by design:

```
PUT …/luns/0 {"size":1073741824}          → 409 reason=session-open
  "LUN 0 of '…:lp2' has 1 live session (…). Resizing a LUN under a live session is refused
   outright — log the initiator out first. This refusal has no confirm bypass."
PUT …/luns/0 {"size":268435456}  (logged out) → 409 reason=shrink, no confirm code
```

Logged out, both kinds grew:

```
grow zvol (LUN 0, 512 MiB → 1 GiB → later 2 GiB):
  {"lun":0,"size":1073741824,"serial":"3183e69f-…","recreated":false}
grow file (LUN 1, 1 GiB → 2 GiB):
  {"lun":1,"size":2147483648,"serial":"2e69b404-…","recreated":true}
```

`recreated:true` is the fileio replay path. After re-login the initiator saw **the same two
serials**, `sdb 1G` / `sdc 2G`, and all three checksums above were byte-identical. The grown
image file stayed sparse (`du -h` 64M of a 2.0G apparent size) and `0600`.

### A.6 Refusals

| Driven | Result |
|---|---|
| `POST /v1/pools/gtbackup/export` under a live session | `409 held-by-lun`, names LUN 0 `lpzvol`, its target, its backing path, the 1 logged-in initiator, and both ways out |
| `DELETE …/luns/0` with a session | `409 session-open` — "LIO would delete it anyway and leave a stale device on the initiator with no kernel message" |
| snapshot rollback of `gtbackup/sparse1` under the LUN | `409 held-by-lun` |
| `PUT` volsize SHRINK through Datasets | `409 shrink`, and the sentence ALSO names the holding LUN and its live session |
| `DELETE` the zvol dataset under the LUN | `409 held-by-lun` |
| `DELETE` dataset `gtbackup/img2` (holds LUN 2's image) | `409 held-by-lun`, names LUN 2 `lpsmall` and its image path |
| `DELETE /v1/ahr/lpahr` (holds LUN 3's image) | `409 held-by-lun` |
| `PUT /v1/ahr/lpahr/mountpoint` | `409 held-by-lun` |
| `POST /v1/backup/restore` into `/gtbackup/img2` | `409 held-by-lun` (a LUN backing dir is a protected restore target) |
| `POST /v1/backup/restore` into `/mnt/pve` | `409` — "PVE territory is read-only for ANAS" |
| `DELETE` a target with a live session | `409 CONFIRMATION_REQUIRED` + `x-anas-confirm-code`, three accurate warnings; confirm → `{"droppedSessions":["iqn.1993-08…"],"backstoresDeleted":["lp3lun"],"backingKept":["/gtbackup/img2/lp3lun.raw"]}`; the target-side session was gone, and the initiator's own record went stale with no kernel message — exactly as the warning predicted |

`heldByLun` is also stamped on the read model: `GET /v1/pools/gtbackup/datasets` carried it on
`gtbackup` and `gtbackup/sparse1`, `GET /v1/ahr` on `lpahr`, and `GET /v1/iscsi/claims` listed
all six claims on the node with `connectedInitiators` and the ready-made sentence.

> The delete-target proof was driven on a purpose-built second ANAS target `lp3` (one 64 MiB
> file LUN, one ACL, logged in) rather than on `lp2`, so the wave's LUNs survived for the
> backup and restore legs. Same code path, same gate. It also answered GT open question 6:
> **two ANAS targets share one portal `address:port` with no complaint**, both serving
> sessions to the same initiator at once.

### A.7 Reboot with the session up

`node.startup=automatic`, session live, then `systemctl reboot`.

**Shutdown ordering** (`journalctl -b -1`, the drop-in doing its job):

```
14:26:58.451867 Stopping rtslib-fb-targetctl.service…
14:26:58.810897 Stopped rtslib-fb-targetctl.service.
14:26:58.821368 Stopped target zfs-volumes.target - ZFS volumes are ready.
14:29:01.164714 Stopped zfs-mount.service - Mount ZFS filesystems.
14:29:01.180063 Unmounting gtbackup.mount - /gtbackup…
```

`ExecStop=/usr/bin/targetctl clear` runs **before** the ZFS layers go away, so no pool export
ever meets GT-40's `dataset is busy`. This is the half GT open question 3 said was unproven.

**Boot ordering:**

```
14:29:06.173358 Finished zfs-volume-wait.service - Wait for ZFS Volume (zvol) links in /dev.
14:29:06.173520 Reached target zfs-volumes.target - ZFS volumes are ready.
14:29:06.174786 Finished zfs-mount.service - Mount ZFS filesystems.
14:29:07.527865 Starting rtslib-fb-targetctl.service…
14:29:07.901140 Finished rtslib-fb-targetctl.service…
```

**Everything restored**: `saveconfig.json` sha256 `016b350b…` byte-identical before and after;
all three LUNs `present:true` with the same serials, sizes and attributes; both ACLs with
their CHAP userids and `chapCredentialsSet:true` / `mutualCredentialsSet:true`;
`security {authentication:false, generateNodeAcls:false, demoModeDiscovery:false}`;
`ownership: anas`; `GET /v1/iscsi/health` clean. The zvol's kernel name moved again
(`/dev/zvol/gtbackup/sparse1 -> ../../zd32`) and nothing cared, because nothing stores it.

After re-login every checksum matched, `marker.txt` read back verbatim, and the ext4 mounted.

*(Initiator-side note, not ANAS's: `open-iscsi.service` ran at `14:29:07` — the same second
`rtslib-fb-targetctl` started — and exited 8. A node that serves iSCSI to ITSELF races its own
target at boot. On any other initiator host this does not arise.)*

### A.8 The hole, and Repair

`systemctl stop rtslib-fb-targetctl; zpool export gtbackup; systemctl start rtslib-fb-targetctl`
→ `Result=success`, `ExecMainStatus=0`, and a target serving nothing. The API caught it:

```
GET /v1/iscsi/health
  missingLuns: [ {lunIndex:0, backstoreName:"lpzvol",  plugin:"block",  backingExists:false},
                 {lunIndex:1, backstoreName:"lpfile",  plugin:"fileio", backingExists:false},
                 {lunIndex:2, backstoreName:"lpsmall", plugin:"fileio", backingExists:false} ]
  targetsServingNothing: [{targetIqn:"…:lp2", persistedLunCount:3, enabled:true}]
  degraded: true
```

`GET /v1/status` raised four `iscsi` warnings — three `warning`-level, one per LUN, and one
`critical`:

```
"The live iSCSI configuration is an incomplete restore (3 LUNs in the saved configuration
 that the kernel does not have). Saving now would write the hole into
 /etc/rtslib-fb-target/saveconfig.json permanently, so iSCSI mutations are refused until
 this is repaired."
```

**Live-proof wave 1's F2 is fixed**: the two file LUNs read `kind: "unresolved"` (not
`foreign`) and the target stayed `ownership: anas`, `ownershipReason: backing-unresolved`.

Mutations were refused (`409 degraded-restore`, naming all three holes), and Repair was refused
while the devices were absent (`409 backing-absent`, "Recreating a backstore over an absent
device is what produced the hole"). After `zpool import -d /var/tmp gtbackup`, Repair
completed:

```
{"repaired":[{"lunIndex":1,"backstoreName":"lpfile","serialReplayed":true},
             {"lunIndex":2,"backstoreName":"lpsmall","serialReplayed":true}],
 "stillMissing":[], "saved":true}
```

Health clean, `degraded:false`, all serials and attributes identical to before the hole, and
the rewritten `saveconfig.json` differs from the pre-hole copy **only in the random per-object
`alias` values** (a 29-line diff, every hunk an alias). `saveconfig` ran **once**, last;
`/etc/rtslib-fb-target/backup/` holds its 10 rotating `.gz` copies (the cap, held).

*(The first Repair attempt failed on the same **F1** bug — a third call site — and left the
tree half-repaired. That is what makes F1 HIGH rather than annoying.)*

### A.9 journald audit

Every mutation produced a submitted/completed pair with the user, the operation, the
parameters and a duration; no secret in any of them. Sample:

```
audit: liveproof@pam submitted iscsi.lun.add
  params {"target":"…:lp2","lun":"lpfile","kind":"file","backing":"/gtbackup/images/lpfile.raw","size":1073741824}
audit: iscsi.lun.add completed (1048ms)
audit: liveproof@pam submitted iscsi.target.update  params {"target":"…:lp2","auth":"mutual-chap","acls":2}
audit: iscsi.target.update completed (148ms)
audit: restored 1/1 selection(s) of hl.pxar from host/lp-files/… into /gtbackup/hl.anas-restore-…
       (side-by-side, 314573849 bytes)
```

---

## B. `iscsi.5` / `iscsi.6` — the rest

### B.1 The AHR-backed fileio path (GT open question 4)

An AHR-1 pool `lpahr` was built through the API on three freshly attached virtual disks of
**mixed size** (2 G, 2 G, 4 G) — confirm-gated create, one md RAID5 band across the matched
2 G partitions (`md127 … [3/3] [UUU]`), LVM, btrfs with the `@data`/`@snapshots` layout,
`nofail` fstab line. Then:

```
POST …/luns {"name":"lpahrlun","kind":"file","backing":"lpahr","size":536870912}
  → {"index":3,"serial":"8157f977-…","backingPath":"/mnt/anas-ahr/lpahr/lpahrlun.raw"}
GET /v1/iscsi/targets/:iqn → LUN 3 kind "file", pool "lpahr"
GET /v1/ahr                → lpahr carries heldByLun for LUN 3
```

A file on btrfs is a first-class fileio backing: created sparse and `0600`, served, written to
from the initiator, and **restored intact across a reboot** —

```
14:43:27.421153 Mounted mnt-anas\x2dahr-lpahr.mount - /mnt/anas-ahr/lpahr.
14:43:28.772918 Starting rtslib-fb-targetctl.service…
```

— health clean, `saveconfig.json` unchanged, checksum `36ea138f…` identical. On this node the
race is not lost: a three-disk md assembly plus an LVM activation plus a btrfs mount finish in
well under the second of slack. The gap is real but small arrays do not expose it.

**What DOES expose it is far worse than a missing LUN — see F2.**

### B.2 The enabled-firewall advisory (GT open question 5)

`pve-firewall` was enabled with an explicit ruleset (SSH and 8006 admitted, plus a 7-minute
self-disarming safety net), then the 3260 rule was added, then widened to a range, then the
whole thing removed. All four states, read from `GET /v1/iscsi/targets/:iqn`'s `firewall`:

| Node state | `enabled` | `admits3260` | `advisory` |
|---|---|---|---|
| enabled, no 3260 rule | `true` | `false` | *"PVE firewall is enabled and no rule admits 3260/tcp — add one in PVE (Datacenter or Node → Firewall); ANAS never edits firewall rules."* |
| enabled, `IN ACCEPT -p tcp -dport 3260` | `true` | `true` | `null` |
| enabled, `-dport 3200:3300` (range) | `true` | `true` | `null` |
| disabled | `false` | `null` | `null` |

`/etc/pve/firewall/` was left exactly as found (empty), and ANAS never wrote a byte of it.

---

## C. `backup2.3` — the AHR runner path, live

`@data/photos` was created as a real btrfs subvolume under the pool (`st_dev` 62 vs 65 — the
detector keys on that, not on `findmnt`), with files in both. `POST
/v1/backup/tasks/preview-nested` named it `kind: "subvolume"`, `detail: "btrfs subvolume id
258"`, and derived `consistency: snapshot / backend: ahr`.

The run (`includeNested: "all"`, one exclude on the LUN image) produced, from the unit's own
result JSON:

```
archives:  ahrdata.pxar: had to backup 655 B …
           ahrdata__photos.pxar: had to backup 620 B …
snapshots: {ahr, anas-backup-lp-ahr-1787755676,          lpahr:@snapshots/…}
           {ahr, anas-backup-lp-ahr-1787755676__photos,  lpahr:@snapshots/…__photos}
expansion: {ahrdata,          root /run/anas-ahr/lpahr.toplevel/@snapshots/anas-backup-…,          excludes ["/lpahrlun.raw"]}
           {ahrdata__photos,  root /run/anas-ahr/lpahr.toplevel/@snapshots/anas-backup-…__photos,  relativePath photos}
```

— **one transient snapshot per subvolume**, both taken under a **held-open top-level mount**
at `/run/anas-ahr/<pool>.toplevel`, expansion into `<name>__photos` with the excludes applied
to the root archive only. The PBS snapshot holds `ahrdata.pxar.didx` **and**
`ahrdata__photos.pxar.didx`. Afterwards `btrfs subvolume list` showed only `@data`,
`@snapshots` and `photos`, `/run/anas-ahr/` was empty and the top-level mount was released:
**every transient destroyed, nothing held.**

The run nevertheless reported a warning claiming `photos` "was stored as an empty directory".
That is **F4**, now fixed; after the fix the same run reports `warnings: null`.

### C.1 `--include-dev` under a `.zfs/snapshot` root — and a bigger fact

Driven by hand against a real recursive snapshot:

```
$ find /gtbackup/.zfs/snapshot/lpid1 -maxdepth 1 -printf '%D\t%p\n'
68  /gtbackup/.zfs/snapshot/lpid1        68  /gtbackup/.zfs/snapshot/lpid1/cdm
68  /gtbackup/.zfs/snapshot/lpid1/img2   68  /gtbackup/.zfs/snapshot/lpid1/data
$ proxmox-backup-client backup idtest.pxar:/gtbackup/.zfs/snapshot/lpid1 \
      --include-dev /gtbackup/.zfs/snapshot/lpid1/cdm …
… exit 0, no warning, no `skipping mount point:` line
$ catalog dump …  →  d "./idtest.pxar.didx/cdm"     (0 entries under it)
                     d "./idtest.pxar.didx/img2"    (0 entries under it)
```

`--include-dev` under a snapshot root is a **silent no-op**: neither an error nor a warning.
The reasoning in `backup2.3` was right. But the measurement says something stronger, and it is
a **GT amendment** — see below: inside a `.zfs/snapshot/<s>` root a child dataset is an EMPTY
directory carrying the ROOT's `st_dev`, and the client says nothing at all about it. Per-dataset
expansion is therefore a correctness requirement on ZFS exactly as GT-55 makes it one on btrfs.

### C.2 The wave-1 F3 sidestep

An NFSv4 export served by the node to itself over a dummy interface was mounted inside the ZFS
source and then black-holed by deleting the address (`timeout 5 ls` → exit 124).

**A snapshot-mode run FINISHED** (~72 s, most of it the two scan ceilings):

```
status: completed
snapshots: [{zfs, anas-backup-lp-f3-1787756351, gtbackup, recursive:true}]
expansion: [{data, root /gtbackup/.zfs/snapshot/anas-backup-lp-f3-1787756351/data}]
warnings:  ["archive 'data': nested filesystem /gtbackup/data/remote (nfs) is NOT included …",
            "archive 'data': the filesystem-boundary scan of /gtbackup/data was incomplete …"]
```

The snapshot root contains no live mounts, so the client never crosses the dead boundary — the
wedge does not reach it. **A LIVE archive over the same tree still wedges** (wave-1 F3 reproduced
exactly): source `/var/tmp/lp-live` on ext4 with the dead mount bind-mounted inside →

```
$ ps -eo pid,stat,wchan:24,args
… Sl  futex_do_wait  /usr/bin/proxmox-backup-client backup live.pxar:/var/tmp/lp-live …
$ systemctl show anas-backup-lp-live-dead.service -p ActiveState -p SubState
ActiveState=activating   SubState=start
```

after 90 s, cleared only by `systemctl stop` plus `SIGKILL`.

**But wave 1's other half does not hold — see F8.** The `find -xdev` walk is hang-BOUNDED, not
hang-proof: 20.1 s against the dead mount, not 17 ms, and the answer comes back `truncated:
true` with real boundaries missing from the list.

---

## D. `backup2.4` — image archives against the real target

One task, two `img` archives, one run:

```
images:    [{archive:"zvollun", source:"/dev/zvol/gtbackup/sparse1@anas-backup-lp-img-1787756755"},
            {archive:"ahrlun",  source:"/run/anas-ahr/lpahr.toplevel/@snapshots/anas-backup-lp-img-1787756755/lpahrlun.raw"}]
archives:  zvollun.img: had to backup 88 MiB of 2 GiB … reused 1.914 GiB (95.7%)
           ahrlun.img:  had to backup 36 MiB of 512 MiB … reused 476 MiB (93.0%)
PBS files: ['zvollun.img.fidx', 'ahrlun.img.fidx', 'index.json.blob']    ← no catalog, as designed
```

The snapdev cycle was caught in flight (`/dev/zvol/gtbackup/sparse1@anas-backup-…` present
while the run read) and was gone afterwards, with `zfs get snapdev gtbackup/sparse1` back to
**`hidden default`** — the `zfs inherit` path, not `set hidden`. Both transient snapshots were
destroyed; `/run/anas-ahr/` was empty again.

`GET /v1/backup/lun-sources` against the real node returned all six LUNs with size, serial,
`backingExists` and a derived `consistency` per LUN — the zvol's reason naming the snapdev
publish, the AHR file's naming the btrfs snapshot, the `gtiscsi/images` file's naming the
recursive ZFS snapshot. Nothing `foreign`, `unresolved` or PVE-owned was offered. **The
foreign TARGET's LUNs were offered, though — F7.**

---

## E. `backup2.5` — the two owed proofs

### E.1 The cross-directory hardlink form — settled

One archive, four hardlink positions, one `catalog shell` session:

```
  File: /a/x                        (the primary — a plain file entry)
  File: /a/z      -> "a/x"          same directory
  File: /b/y      -> "a/x"          different directory
  File: /c/deep/w -> "a/x"          deeper directory
  File: /rootfile                   (a second primary)
  File: /rootlink -> "rootfile"     archive root
  Size: 0   Type: symlink   Access: (0/L---------)   Modify: 1970-01-01 00:00:00
```

**The target is always the primary's path relative to the ARCHIVE ROOT, with no leading
slash** — never a sibling name, never absolute. The client renders it with `Type: symlink`,
mode `0`/`L---------`, size 0 and an epoch mtime; ANAS's own browse correctly returns
`{"type":"hardlink","target":"a/x"}` for it. The earlier "bare primary name" reading came from
a pair that happened to sit at the archive root, where the two readings coincide. This is what
**F6** turned on.

### E.2 `Modify:` under a non-UTC node timezone

```
TZ=Etc/UTC          → Modify: 2026-08-26 15:06:53   API modified "2026-08-26 15:06:53"
TZ=America/New_York → Modify: 2026-08-26 11:06:53   API modified "2026-08-26 11:06:53"
```

`catalog shell` renders `Modify:` in the **reading process's local timezone with no offset
marker**, and ANAS carries the string verbatim. See F11.

---

## F. `backup2.6` — restores for real

| Mode | Driven | Result |
|---|---|---|
| side-by-side, default name | select `/a` | `target: /gtbackup/hl.anas-restore-2026-08-26T15-07-00Z`, `restored:["/a"]`, `missing:[]`, `merge:false` |
| side-by-side, second run | same request again | `409` — *"'…' already exists. A side-by-side restore always creates a new directory — move or remove that one first (if it holds a .anas-restore-partial marker, it is an unfinished restore of this same point in time)."* |
| in-place, single file | `/a/plain.txt` after a local edit | **no gate**, `202` → file restored, `merge:true` |
| in-place, TREE | `/a` | `409 CONFIRMATION_REQUIRED` + `x-anas-confirm-code`; confirm → completed; `foreign.txt` (never in the archive) **survived**, `plain.txt` restored |
| `--ignore-permissions` | side-by-side `/a` | every restored file `-rw-------`, the created directory `drwx------` |
| hardlink completion | select only `/b/y` | `addedForHardlinks:["/a/x"]`, `patterns:["/b/y","/a/x"]`, both restored **sharing one inode** — after **F6**; before it, the whole restore died |
| no-match selection | `/a/plain.txt` + `/nosuch/file.txt` | `400` up front: *"This snapshot's 'hl.pxar' does not hold /nosuch/file.txt - the client would report success and restore nothing for those, so the restore is refused instead."* |
| killed client | `--rate 5MB` restore of a 300 MiB tree, `SIGKILL` at ~20 s | job `failed`; `.anas-restore-partial` written; the in-flight `blob.bin` **98615296 of 314572800 bytes and mode 0600** — GT-60's only hint, exactly |
| protected targets | `/gtbackup/img2` (a LUN backing dir), `/mnt/pve` | both `409`, quoted in §A.6 |
| progress + `--rate` | `--rate 5MB`, 300 MiB | lines parsed at **5.2 s, 15.8 s, 36.1 s** — the doubling cadence — then `restore complete (300.002 MiB processed in 1m 2.9s, average 4.768 MiB/s)`; `--rate 5MB` is base-10, i.e. ~4.77 MiB/s |

The `missing[]` path could not be reached from the API (**NOT-POSSIBLE**): the pre-flight
`catalog shell` stat refuses any selection the archive does not hold, so a silent no-match
never reaches the client. `missing[]` remains as the belt-and-braces post-restore check.

---

## G. `backup2.7` — whole-image restore

**Nothing in this story had ever run.** The first attempt died in 968 ms:

```
Error: unable to open /dev/stdout - No such device or address (os error 6)
Nothing was written to /dev/zvol/gtbackup/sparse1.
```

That is **F3** — the feature did not work at all. Fixed; then, driven for real:

**The three entry gates**, before anything destructive:

```
live session      → 409 live-sessions  "1 initiator is logged in to …:lp2 right now: … .
                    Restoring an image over a LUN an initiator has open would overwrite the
                    device under a mounted filesystem, and neither LIO nor the initiator would
                    be told. Log the initiator(s) out first."
size mismatch     → 409 size-mismatch  "archive 'ahrlun.img' is 536870912 bytes,
                    /gtbackup/img2/lpsmall.raw is 268435456 bytes. The image is LARGER than the
                    target: the restore would write until the device is full and leave it
                    half-overwritten …"                      ← BOTH numbers, as ruled
foreign target    → 409 foreign-target "Target '…gtiscsi:target1' is not managed by ANAS …"
```

**The confirm body** names the whole-target consequence and counts the collateral LUNs:

```
409 CONFIRMATION_REQUIRED — "Restoring ahrlun.img from … over LUN 3 of …:lp2"
  • "This OVERWRITES /mnt/anas-ahr/lpahr/lpahrlun.raw completely — every byte currently on
     LUN 3 is replaced by the 536870912 bytes in the backup, and there is no undo."
  • "The WHOLE TARGET goes offline for the duration, not just this LUN: LIO's enable flag
     lives on the target portal group, so its other 3 LUNs are unreachable too."
  • "Disabling refuses new logins and hides the target from discovery, so an initiator that
     auto-reconnects (open-iscsi, Windows) cannot come back mid-restore. It is re-enabled
     when the restore finishes."
  • "If the restore fails part-way, the LUN holds a HALF-WRITTEN image and the target stays
     disabled until you restore again or explicitly enable it."
```

**The zvol branch**, watched while it ran (`tpgt_1/enable` polled every 5 s):

```
t5s  tpg=0  running | restoring zvollun.img … into /dev/zvol/gtbackup/sparse1 (2147483648 bytes …)
t10s tpg=0  running | restore progress 7% (148 MiB of 2 GiB in 6.2s, 23.92 MiB/s)
t20s tpg=0  running | restore progress 8% (168 MiB of 2 GiB in 16.7s, 1.902 MiB/s)   ← --rate 2MB
t40s tpg=1  completed
result: {"targetPath":"/dev/zvol/gtbackup/sparse1","imageSize":2147483648,
         "bytesWritten":2147483648,"complete":true,
         "targetDisabled":true,"targetReEnabled":true,
         "duration":"restore complete (2 GiB processed in 35.6s, average 57.537 MiB/s)"}
```

The whole target was offline for the duration (`enable=0`, so its other three LUNs went with
it), the serial and every attribute read back unchanged, the target was re-enabled in the
`finally`, and after re-login the initiator mounted the ext4 and read
`sha256(payload.bin) = de93cda9…` — the pre-scribble value.

**The AHR image-file branch**: same shape, `bytesWritten 536870912`, `complete:true`, and the
image file kept **the same inode (257)** — rewritten in place, so the fileio backstore never
had to be recreated and the serial was never at risk. Content read back `36ea138f…`.

**The partial path**: `SIGKILL` on the client 12 s in →

```
status: failed
"the image was partially written (at least 150323855 of 2147483648 bytes reached
 /dev/zvol/gtbackup/sparse1); the LUN is disabled until you restore again or accept the
 state. progress 7% (148 MiB of 2 GiB in 6.2s, 23.795 MiB/s)"
tpg enable: 0                       ← the target stays DISABLED, as designed
```

`POST /v1/iscsi/targets/:iqn/state {"action":"enable"}` brought it back (`enable=1`), and a
clean re-restore left the LUN whole again. The `"at least"` wording is the fix in `200eac0`
doing its job (see F3's byte-accounting half).

---

## H. Wave-1 regression, after everything

```
GET /v1/iscsi/targets            200      GET /v1/iscsi/sessions   200
GET /v1/iscsi/health             200      GET /v1/iscsi/claims     200
GET /v1/iscsi/targets/not-an-iqn 400   ("Must be an iSCSI name: iqn.YYYY-MM.<reversed domain,
                                        at least two labels>[:<unique>], eui.…, naa.…")
GET /v1/iscsi/targets/<unknown>  404
```

Through the gateway with a PVE ticket: `/v1/iscsi/targets` `200`, the URL-encoded IQN `200`,
`/v1/status` `200`, `/v1/backup/lun-sources` `200`, `X-Anas-Version: 0.2.12` — matching the
daemon and the UI bundle, so no skew banner.

Volumes (`iscsi.3`): sparse create with explicit `volblocksize` (`refreservation 0 default`),
grow, shrink refused `409` **with no confirm code**, `recordsize` on a volume `400`, snapshot,
confirm-gated destroy — all as wave 1.

Nested matrix on `/gtbackup` (two child datasets): `none → (cdm:false, img2:false)`,
`all → (true,true)`, `["/gtbackup/cdm"] → (true,false)`. A live-mode run of `/etc` still
warns `nested filesystem /etc/pve (pmxcfs) is NOT included` — the never-silent contract
survives the F4 fix.

---

## Findings

### F1 — HIGH (`iscsi.4`/`iscsi.5`) — **FIXED** (`6185bb6`): a LUN could not be added to a target that has an ACL

`targetcli`'s `auto_add_mapped_luns` preference (GT-7, default **true**) maps a brand-new TPG
LUN into every existing ACL by itself. `addIscsiLun` and `repairIscsiHoles` then issued an
explicit `acls/<iqn> create n n` from an ACL snapshot taken BEFORE the mutation:

```
targetcli /iscsi/…:lp2/tpg1/acls/iqn.1993-08.org.debian:01:ae3d2ec18ad create 0 0 failed:
This MappedLUN already exists in configFS
```

The job reported **failed** over work that was in fact complete, and — because the failure
came before the final `saveconfig` — left the live tree **unpersisted**. A target with no ACL
serves nobody, so this is the normal case, not an edge one. The same bug took down
`POST /v1/iscsi/health/repair` after a pool re-import, leaving the repair half-done: two LUNs
back, one grant failed, no save.

Fix: `grantLunsToAcl` reads the ACL's live mapped set out of configfs at the point of use
(`readMappedLuns`, exported; `aclDirPath` factored out of `aclAuthPath` with the same IQN
validation), and `iscsi-repair.ts` uses that ONE helper instead of its own copy of the loop
(single-source rule). Regression tests in `iscsi-mutate.test.ts` (already-mapped → no
duplicate create, still reaches `saveconfig`; not-yet-mapped → still granted) and
`iscsi-repair.test.ts` (a repair over an auto-mapped LUN issues no `acls/` command and saves).

### F2 — HIGH (`iscsi.5`, `backup2.7`) — NOT FIXED: an unmounted image-LUN filesystem is not a hole, it is a silent EMPTY DISK

The AHR boot gap is documented as "the LUN may not restore, and `/v1/iscsi/health` surfaces
it". What actually happens is worse. Simulated by unmounting the AHR pool and restarting the
restore service (the exact shape of a `nofail` mount that has not happened yet):

```
$ ls -la /mnt/anas-ahr/lpahr/
-rw-------  1 root root  0  Aug 26 14:44 lpahrlun.raw      ← LIO CREATED it, 0 bytes
$ cat …/core/fileio_*/lpahrlun/info
Status: ACTIVATED …  File: /mnt/anas-ahr/lpahr/lpahrlun.raw  Size: 536870912
$ GET /v1/iscsi/health   →  degraded false,  missingLuns []      ← nothing to report
$ GET /v1/status         →  no iscsi warning at all
$ GET …/luns/3           →  present true, backingExists true, serial 8157f977-… (unchanged)
$ initiator: login, 512 MiB disk, SAME serial, 32 MiB read →  ALL ZEROES
```

`targetctl restore` **creates** a missing fileio backing file at the requested size, because
the mountpoint DIRECTORY still exists. The LUN comes up activated, the right size, the right
serial — and empty. The health model cannot see it: nothing is missing. The one signal is
collateral and points the wrong way — the LUN's `kind` flips to `foreign` and takes the target
with it (`ownership: foreign`, `backing-not-anas-storage`), i.e. ANAS declares the target
hands-off at the exact moment it needs managing.

This is not AHR-specific. Any fileio LUN whose filesystem is a mount that fails or is late —
a ZFS child dataset that did not mount, a remote mount, an AHR pool — has the same shape,
because only the *pool export* case removes the parent directory.

Recovering was easy once seen (stop the service, delete the stub, mount, start) and lost
nothing, but nothing in ANAS told the operator to.

**It then happened for real, unprompted.** The `post-wave2-liveproof` snapshot forced the VM
off; `test/stunt-node/add-disk.sh` attaches with `--live` only, so the three AHR disks did not
come back on the next boot. With no md array, no VG and no mount, the boot produced exactly the
state above by itself:

```
$ cat /proc/mdstat                         unused devices: <none>
$ ls -la /mnt/anas-ahr/lpahr/
-rw-------  1 root root  0  Aug 26 15:49 lpahrlun.raw       ← fresh, created at boot
$ GET /v1/iscsi/health   →  degraded False,  missingLuns []
$ GET …/luns/3           →  present true, backingExists true, size 536870912
```

A whole storage pool vanished and ANAS reported a healthy iSCSI tree. Re-attaching the disks,
stopping the restore service, deleting the stub, mounting and restarting brought the real image
and its serial straight back — but only because the operator knew to look.

Candidates, all design calls: treat a fileio backing of length 0 (or `< size`) as a hole in
`iscsi-health.ts`; record the backing's expected filesystem in the health diff and compare
against `findmnt`; and promote the standing "AHR boot-ordering anchor"
(`x-systemd.before=rtslib-fb-targetctl.service` on the AHR fstab line) from a candidate to a
requirement, since the failure mode it prevents is a silently blank disk rather than an absent
one.

### F3 — HIGH (`backup2.7`) — **FIXED** (`200eac0`): image restore did not work at all

`proxmox-backup-client restore … -` does not write to fd 1 — it **opens `/dev/stdout`**.
libuv backs a `'pipe'` stdio slot with a `socketpair(2)`, and reopening a socket through
`/proc/self/fd` fails with ENXIO, so every image restore died before a byte was written. The
ground truth never caught it because every by-hand capture used a shell redirect, which is a
real descriptor. Measured, by hand, on the node:

```
restore … - > /dev/zvol/gtbackup/sparse1     exit 0, 2 GiB written   (shell redirect: fine)
restore … - > /var/tmp/imgout.raw            exit 0, 512 MiB          (regular file: fine)
restore … - | wc -c                          536870912                (pipe(2): fine)
via execToStream                             ENXIO on /dev/stdout     (socketpair: not fine)
```

Fix: `execToStream` hands the child the descriptor ANAS opened as its own fd 1
(`stdio: ['ignore', fd, 'pipe']`) instead of copying through a Node pipe — which is also what
DESIGN.md already describes ("streamed via `restore … -` into a fd ANAS opens") and is
zero-copy. The `fsync` stays ours, on the still-open descriptor, after the child exits.

**Byte accounting had to follow**: a child that reopens `/dev/stdout` gets its own file
description, so our offset never moves. `imageBytesWritten()` takes the descriptor's count
when it moved, the manifest size when the client printed `restore complete`, and otherwise the
last reported percentage as a LOWER BOUND, labelled `at least` in the partial verdict. Without
it a mid-stream failure would have claimed *"Nothing was written"* over a half-overwritten
device, and every success would have warned that 0 bytes arrived.

Regression tests: `exec-to-stream.test.ts` (a child that opens `/dev/stdout` BY PATH writes
into the target) and `backup-restore.test.ts` (the four `imageBytesWritten` cases).

### F4 — MEDIUM (`backup2.3`/`backup2.2`) — **FIXED** (`9207a04`): a snapshot-mode run warned forever about boundaries it had covered

`skippedWarnings` dropped a client `skipping mount point:` line only when its ABSOLUTE path
matched one our own walk had named. In snapshot mode those two paths can never be equal — the
walk names `/mnt/anas-ahr/lpahr/photos`, the client is reading
`/run/anas-ahr/lpahr.toplevel/@snapshots/anas-backup-…/photos` (or, on ZFS,
`<mountpoint>/.zfs/snapshot/<s>/…`). So an AHR source with `includeNested: all`, whose nested
subvolume was expanded into its own archive and fully backed up, reported

```
archive 'ahrdata': the client skipped mount point "photos" (…) - it was stored as an empty directory
```

on **every** run. Under the standing ruling that pins the run at completed-with-warnings and
the 16.12 notification at `warning` forever — which choosing `all` is exactly what is supposed
to stop.

Fix: match on the archive-relative path as well as the absolute one (expansion preserves the
tree, so the string is the same on both sides). Nothing is lost — `nestedRunWarnings` still
emits "is NOT included" for anything uncovered, proven live afterwards on a `/etc` run.

### F5 — MEDIUM (`backup2.3`) — **FIXED** (`9b92479`): Run-Now dropped `consistency` / `snapshots` / `expansion`

DESIGN.md promises the run result carries all three. `runBackup` emits them (they reach the
unit journal), but `classifyTerminalRun` copied only a subset out of the helper JSON — the
same omission wave 1 caught for `includedNested`. `POST /v1/backup/tasks/:name/run` therefore
could not say whether a run was snapshot-consistent or live, which transients it took, or
which archive roots the client was handed. Forwarded exactly as `prune` is; an absent field
stays absent.

### F6 — MEDIUM (`backup2.6`) — **FIXED** (`2cc6b28`): a cross-directory hardlink could not be restored

`hardlinkPrimaryPath` read a bare `catalog shell` target as a SIBLING of the entry that named
it — the code said so, and said the real form "is not settled by any capture we hold". §E.1
settles it: the target is always **archive-root-relative**. Selecting `/b/y` therefore
completed the group with `/b/a/x`, a pattern matching nothing, so the "completed" group was
not complete and pbc died with GT-25's `failed to extract hardlink: ENOENT` — the exact failure
the completion exists to prevent. The job diagnosed it correctly and left a partial marker, but
no cross-directory hardlink could be restored at all. All four positions now restore with the
partner added and the two names sharing an inode.

### F7 — MEDIUM (`backup2.4` ⟷ `backup2.7`) — NOT FIXED: `lun-sources` offers a foreign target's LUNs, the image restore refuses them

`GET /v1/backup/lun-sources` filters on the LUN's backing **kind** (`foreign`/`unresolved`/PVE)
and deliberately not on the target's **ownership** — the route documents why. So the hand-built
`iqn.2026-08.dev.anas.gtiscsi:target1` (ownership `foreign`, hands-off) had both its LUNs
offered as backup sources, because they sit on ANAS-managed ZFS. `POST /v1/backup/restore`
with `kind:'image'` then refuses that same LUN:

```
409 foreign-target — "Target 'iqn.2026-08.dev.anas.gtiscsi:target1' is not managed by ANAS
and is hands-off: IQN … was not generated by ANAS …"
```

A user can back a LUN up and never be allowed to restore it. Either the picker should exclude
foreign targets, or the restore should accept them; today the two doors disagree. (`iscsi.7`'s
brief expected the first; the built contract chose the second. Operator call.)

### F8 — MEDIUM (`backup2.2`) — NOT FIXED: the nested-filesystem walk is hang-BOUNDED, not hang-proof

Wave 1 recorded "17 ms against a dead server: recorded from `findmnt`, pruned from the walk,
never stat'ed". That is not general. With the same shape rebuilt and the dentry cache cold:

```
POST /v1/backup/tasks/preview-nested {"path":"/gtbackup/data"}     real 0m20.111s
  truncated: true
  warnings: ["the filesystem-boundary scan of /gtbackup/data did not finish within 20s —
              the list below is a floor, not a complete answer"]
```

and on `/gtbackup`, only the dead mount came back — the two real child datasets `cdm` and
`img2` were lost from the answer. By hand, the prune term does not help:

```
$ timeout 8 find -P /gtbackup/data -xdev -maxdepth 3 \( -name .zfs -o -path /gtbackup/data/remote \) \
      -prune -o -type d -printf '%D\t%p\n'
exit=124        (and it printed NOTHING, not even the source root)
```

`find` must `lstat` an entry before the expression runs, and `lstat` on a black-holed NFS
mountpoint blocks. The 20 s `timeout` ceiling is the only guard — it works (no D-state process
was left behind, the daemon stayed responsive) and the truncation is reported honestly, but
the claim "never stat'ed" should not stand, and a source with a dead mount costs 20 s per scan
and returns a floor. Candidate remedy: prune from the mount table BEFORE descending — walk
level by level with the known mountpoints excluded by `-mindepth/-maxdepth`, or stat each
child under its own short `timeout`.

### F9 — MEDIUM (Epic 16) — NOT FIXED: a DISABLED backup task's run history is garbage-collected

`lastRunAt` is read from `ExecMainExitTimestamp` / `InactiveEnterTimestamp`. systemd unloads an
inactive unit that nothing references, and a task saved with `enabled: false` has no timer to
reference it — so after a real, successful, journal-attested run:

```
$ systemctl show anas-backup-lp-ahr.service -p Result -p ExecMainExitTimestamp -p InactiveEnterTimestamp
Result=success
ExecMainExitTimestamp=
InactiveEnterTimestamp=
$ GET /v1/backup/tasks/lp-ahr   →  lastRunResult "success",  lastRunAt null
```

(The same unit, once **enabled**, reports both correctly.) Composed with wave 1's O2 —
"unknown reads as success" — a disabled task reports **"success / never"** regardless of what
actually happened, including after a failure. `rtslib-fb-targetctl`, also `Type=oneshot` but
referenced by its `WantedBy=`, keeps its timestamps, so this is unit-reference lifetime, not a
systemd version quirk. It is a genuine hole in the standing "the units are the store" ruling
and wants a ruling of its own.

### F10 — LOW (`iscsi.6`) — **FIXED** (`3af3aee`): the held-by-LUN refusal blamed ZFS on non-ZFS objects

`heldByLunRefusal` renders ONE sentence for ZFS pools and datasets, AHR pools (btrfs on LVM on
md) and remote mounts alike, and that sentence asserted *"ZFS does not stop this on its own —
it would either fail with a bare 'dataset is busy' …"*. Read live, `DELETE /v1/ahr/lpahr` and
the AHR mountpoint change both blamed ZFS for a btrfs pool, as did the restore-target refusal
for a plain directory. Now backend-neutral and true everywhere it is rendered.

### F11 — LOW (`backup2.5`) — NOT FIXED: `modified` is naked node-local time

`BackupBrowseEntry.modified` carries `catalog shell`'s `Modify:` string verbatim, which is
rendered in the **reading process's** timezone with no offset (§E.2). A UI that treats it as
UTC is wrong by the node's offset, and two nodes in different zones disagree about the same
archive. Either label it, or normalise it (the daemon knows its own zone).

### F12 — LOW (`backup2.7`) — NOT FIXED: a target left disabled after a failed image restore raises no dashboard warning

The partial path deliberately leaves the target DISABLED as the operator's to acknowledge, and
says so in the job error. But the job is ephemeral by design, and `GET /v1/status` showed **no
`iscsi` warning at all** while a half-written LUN sat on a disabled target. "Dashboard shows
failures" would seem to cover this one.

### F13 — LOW (`iscsi.3` ⟷ `iscsi.4`) — NOT FIXED: two doors disagree about growing a LUN under a live session

`PUT /v1/iscsi/targets/:iqn/luns/:n` refuses ANY resize under a live session, deliberately
("one rule that is true beats two that need explaining"). `PUT
/v1/pools/:pool/datasets/:name {"properties":{"volsize":…}}` on the same held zvol **accepts a
grow** — which `iscsi.3` explicitly allows ("grow (live under a LUN — the initiator rescans)")
and which is in fact safe: measured live, the initiator kept showing 1 G until
`iscsiadm … -R`, then 2 G. Both positions are defensible; that they differ is not obvious to a
user who meets the iSCSI refusal first.

### F14 — LOW (packaging) — NOT FIXED: the dev deploy path does not install the iSCSI ordering drop-in

`packaging/install.sh` installs
`/etc/systemd/system/rtslib-fb-targetctl.service.d/anas-ordering.conf`;
`test/stunt-node/deploy-anas.sh` does not, and the node had no drop-in after a deploy. It was
installed by hand (byte-identical `[Unit]` stanza) before the `iscsi.5` legs. Fleet nodes
installed from the tarball are fine; dev nodes silently lose the boot and shutdown ordering,
which is exactly what a live proof must not have to remember.

### F15 — LOW (Epic 4) — NOT FIXED: destroying a volume with snapshots returns the raw ZFS message

```
DELETE /v1/pools/gtbackup/datasets/lpvol9   (confirmed)  → job failed
  "cannot destroy 'gtbackup/lpvol9': volume has children
   use '-r' to destroy the following datasets: gtbackup/lpvol9@r1"
```

Correct, and safe, but it is the bare CLI text — "guide, don't just warn" would name the
snapshots and the next step. Pre-existing, not new to 0.3.0.

### F16 — LOW (`backup2.6`) — NOT FIXED: the partial marker's `reason:` is a progress line after a SIGKILL

A killed client leaves no message, so the marker records the last progress line in the
`reason:` field:

```
reason: progress 22% (68.431 MiB of 300.002 MiB in 15.8s, 4.185 MiB/s)
last progress: progress 22% (68.431 MiB of 300.002 MiB in 15.8s, 4.185 MiB/s)
```

Honest, but it reads as though the progress WAS the reason. A sentence for the
"client died without saying why" case would cost one line.

---

## GT amendments

Facts the ground-truth documents got wrong, lacked, or left open — all measured this session.

### `docs/ISCSI-GROUND-TRUTH.md`

1. **GT-7 bites the WRITER, not just the reader.** `auto_add_mapped_luns=true` means
   `/…/tpg1/luns create` maps the new LUN into every existing ACL **before** any explicit
   grant runs, so a pre-mutation ACL snapshot is stale by the time it is used. (F1.)
2. **A missing fileio backing file is CREATED by `targetctl restore`**, at the recorded size,
   whenever its parent directory exists — and the LUN then comes up `ACTIVATED` with the right
   serial and nothing but zeros. GT-20/GT-21 describe only the *pool-gone* case, where the
   directory disappears with it. (F2.)
3. **`demo_mode_discovery=0` works as intended, and only that.** An initiator with no ACL in
   the TPG does not see the target in `SendTargets` (proven with a second `iscsiadm` iface);
   an initiator that HAS an ACL does, and `enforce_discovery_auth` stays `0`.
4. **`authenticate_target=1` is not a restriction.** An initiator that does not demand mutual
   CHAP still logs in; mutual is offered, not imposed. A WRONG `password_in` on the initiator
   does fail the login (error 19), so the target genuinely presents its credentials.
5. **`saveconfig.json` is stable modulo `alias`.** A hole + a full surgical repair produced a
   file differing from the pre-hole copy in nothing but the random per-object `alias` values
   (29 diff lines, every hunk an alias) — a usable equivalence test for future proofs.
6. **Multiple targets share one portal `address:port`** (GT open question 6, partly answered).
   Two ANAS targets on `192.168.200.50:3260`, both serving sessions to the same initiator,
   with no complaint from LIO and no interaction between their TPG enable flags.
7. **The PVE volid is `scsi-36001405` + the first 25 hex characters of the unit serial.** Two
   volids, both matching their LUN's serial exactly.
8. **`pvesm remove` leaves the session** (GT-46 re-confirmed on a second target).
9. **A node that serves iSCSI to itself races its own target at boot**:
   `open-iscsi.service` ran in the same second as `rtslib-fb-targetctl` and exited 8.
   Initiator-side, not ANAS's, but it will confuse anyone testing on one box.
10. **The block backstore's size is unreadable while the pool is exported** — `GET
    …/luns/:n` reports `size: null` for the zvol LUN and the persisted size for the fileio
    ones (which carry it in `saveconfig.json`). Asymmetric but honest.
11. **GT open question 3 is closed for shutdown**: with the ordering drop-in,
    `rtslib-fb-targetctl` stops ~2.5 minutes before the ZFS unmounts, and the boot half orders
    behind `zfs-volume-wait` / `zfs-mount` by ~1.35 s on this node.
12. **GT open question 4 is closed**: fileio on btrfs (AHR) works — created sparse, served,
    written, grown by the recreate path, backed up from a btrfs snapshot, restored in place at
    the same inode, and restored across a reboot.
13. **GT open question 5 is closed**: the firewall advisory measured in all four states, single
    port and range.

### `docs/BACKUP-RESTORE-GROUND-TRUTH.md`

14. **The hardlink target form is settled** (backup2.5's owed proof): `catalog shell stat`
    prints a non-primary name as `-> "<primary path relative to the ARCHIVE ROOT, no leading
    slash>"`, with `Type: symlink`, mode `0`/`L---------`, `Size: 0` and an epoch `Modify:`.
    Verified same-directory, different-directory, deeper-directory and archive-root. The
    earlier "bare primary name" reading was an archive-root pair, where the two readings
    coincide. (F6.)
15. **Under a `.zfs/snapshot/<s>` root a child dataset is an EMPTY directory with the ROOT's
    `st_dev`.** So `--include-dev` there is a silent no-op (confirmed: exit 0, no warning),
    **and the client emits no `skipping mount point:` line either** — its secondary signal is
    completely blind in ZFS snapshot mode. Per-dataset expansion is therefore a correctness
    requirement on ZFS exactly as GT-55 makes it one on btrfs, and the never-silent contract
    rests entirely on ANAS's own walk of the LIVE tree.
16. **`find -path <mount> -prune` does not protect against a dead NFS mount.** `find` lstats
    every entry before the expression runs. `timeout` is the only guard; the result is
    `truncated`. (F8.)
17. **`proxmox-backup-client restore … -` opens `/dev/stdout` BY PATH.** It works over a shell
    redirect to a device, a regular file or a `pipe(2)`; it fails with
    `No such device or address (os error 6)` when fd 1 is a socket — which is what Node/libuv
    gives a `'pipe'` stdio slot. Any future capture must be taken through the same plumbing the
    daemon uses. (F3.)
18. **A pre-flight `catalog shell` stat makes GT-24's "silent no-match" unreachable from the
    API**: `POST /v1/backup/restore` refuses a selection the archive does not hold with a
    `400` before the client runs.
19. **`--rate` on a files restore works and is base-10**: `--rate 5MB` produced a 4.768 MiB/s
    average, and the doubling progress cadence was reproduced at 5.2 s / 15.8 s / 36.1 s
    (GT-59's 6/16/36/79 on a longer run).
20. **`Modify:` is rendered in the READER's local timezone with no marker** — the same entry
    reads `15:06:53` under `Etc/UTC` and `11:06:53` under `America/New_York`. (F11.)
21. **`--ignore-permissions` also lands the created DIRECTORY at `0700`**, not only files at
    `0600`.
22. **A killed restore's in-flight file is short AND `0600`** — GT-60 reproduced exactly
    (98615296 of 314572800 bytes).

---

## Suggested EPICS.md / DESIGN.md changes (not made here)

- **`iscsi.5`** — the "Open (candidate, needs a migration)" note on AHR boot ordering
  understates the failure: record F2 (an unmounted image-LUN filesystem yields a *silently
  blank* activated LUN, not a missing one) and decide whether the health diff gains a
  zero-length-backing check. The candidate in §4 ("AHR boot-ordering anchor for iSCSI") should
  say the same.
- **`backup2.4` / DESIGN's `lun-sources` row** — settle F7: either "foreign and unresolved
  backings **and foreign targets** are never offered", or a matching relaxation in
  `backup2.7`'s preflight.
- **`backup2.2`** — replace "ANAS's own detection is hang-proof (17 ms …)" with the measured
  truth: hang-bounded at the 20 s ceiling, `truncated: true`, list incomplete (F8).
- **`backup2.3`** — the `--include-dev`-under-a-snapshot-root note can be marked proven, and
  strengthened with GT amendment 15 (the client's skip-line signal is blind there, so
  expansion is a correctness requirement on ZFS too).
- **`backup2.5` / `backup2.6`** — the owed hardlink-form proof is delivered (amendment 14);
  the "both are handled" hedge in the design text is superseded.
- **`backup2.7`** — DESIGN already says "into a fd ANAS opens"; the implementation now matches.
  Worth recording the `/dev/stdout` fact so no one reintroduces a Node pipe.
- **Epic 16 / the "units are the store" ruling** — F9 needs a ruling: a disabled task has no
  durable run history at all.
- **Packaging** — `test/stunt-node/deploy-anas.sh` should install the ordering drop-in (F14).

---

## Node state left behind

**iSCSI** (`GET /v1/iscsi/health`: `degraded false`, no missing LUNs, no targets serving
nothing, no portals without an interface, no foreign changes; no `iscsi` dashboard warning):

| Target | Ownership | LUNs | ACLs | Sessions | Enabled |
|---|---|---|---|---|---|
| `iqn.2026-08.anas-pve.anas:lp2` | `anas` | 4 | 2 | 1 | yes |
| `iqn.2026-08.dev.anas.gtiscsi:target1` | `foreign` | 2 | 2 | 0 | yes |

`lp2`'s LUNs: `lpzvol` (zvol `gtbackup/sparse1`, 2 GiB, serial `3183e69f-…`, holds an ext4
`LPZVOL` with `marker.txt` + `payload.bin` `de93cda9…`); `lpfile`
(`/gtbackup/images/lpfile.raw`, 2 GiB); `lpsmall` (`/gtbackup/img2/lpsmall.raw`, 256 MiB);
`lpahrlun` (`/mnt/anas-ahr/lpahr/lpahrlun.raw`, 512 MiB, content `36ea138f…`). Both ACLs still
carry their CHAP and mutual-CHAP credentials with `auth: none` on the TPG — switch `auth` back
to `chap`/`mutual-chap` and they work again without re-entering a secret. `saveconfig.json`
sha256 `0575f97b…`, 10 rotating backups.

**Pools:** ZFS `gtbackup` and `gtiscsi` (unchanged, file vdevs under `/var/tmp`) plus the new
**AHR-1 pool `lpahr`** — three virtual disks `ANAS_HOT1/2/3` (2 G, 2 G, 4 G), one md RAID5
band, mounted at `/mnt/anas-ahr/lpahr` with the `@data`/`@snapshots` layout and a nested
subvolume `photos`. `gtbackup` also gained the dataset `gtbackup/img2`, the directory
`/gtbackup/hl` (hardlink test tree, ~300 MiB) and the snapshot `gtbackup/sparse1@lpsnap1`.

**Backup tasks** (all enabled, all on `lp-repo` / namespace `gtrestore`): `lp-ahr`
(AHR source with `includeNested: all`), `lp-files` (`/gtbackup/hl`), `lp-img` (two `img`
archives — the zvol LUN and the AHR image LUN).

**New PBS groups** in namespace `gtrestore`: `lp-ahr` (4), `lp-files` (2), `lp-img` (1),
`lp-etc` (1), `lp-f3` (1), `lp-includedev` (1) — kept deliberately as restore material.

**Removed again:** the temporary target `lp3` and its image; the temporary tasks `lp-etc`,
`lp-f3`, `lp-live-dead`; the temporary NFS export, its dummy interface and both mountpoints
(`/etc/exports` restored byte-identically); the PVE storage `liveproof`; the volume
`gtbackup/lpvol9`; the recursive probe snapshot `gtbackup@lpid1`; every side-by-side restore
directory and by-hand scratch file; the second `iscsiadm` iface and its node record.

**Also changed:** `/etc/systemd/system/rtslib-fb-targetctl.service.d/anas-ordering.conf`
installed by hand (F14). `pve-firewall` back to `disabled`, `/etc/pve/firewall/` empty.
Timezone back to `Etc/UTC`. `node.startup=automatic` on the `lp2` node record.

**Snapshots taken:** `pre-wave2-liveproof` (before anything) and `post-wave2-liveproof`
(after everything above).

> **Caveat for whoever picks this node up:** `add-disk.sh` attaches with `--live` and no
> `--config`, so `ANAS_HOT1/2/3` do NOT survive a power cycle — and without them the AHR pool
> is absent and LIO recreates LUN 3's image as a 0-byte stub (that is F2, and it is how F2 was
> confirmed a second time). After any full stop, re-run `./test/stunt-node/add-disk.sh 1 2 3`,
> then `systemctl stop rtslib-fb-targetctl && umount /mnt/anas-ahr/lpahr && rm -f
> /mnt/anas-ahr/lpahr/lpahrlun.raw && mount /mnt/anas-ahr/lpahr && systemctl start
> rtslib-fb-targetctl`. Done once already: the node is healthy as described above.

---

## iscsi.8 live proof

Stunt node `anas-pve` (192.168.200.50), snapshots `pre-iscsi8` (before anything) and
`post-iscsi8` (after everything below). Dev build of `iscsi.8` deployed with
`test/stunt-node/deploy-anas.sh`.

| # | Leg | Verdict |
|---|---|---|
| 0 | F2 reproduced ON THE OLD BUILD by a real power cycle | **PASS** (the bug is real, and unprompted) |
| 1 | Daemon-start quarantine of the placeholder the boot left behind | **PASS** |
| 2 | Unmount the AHR pool → restart the restore service → card, LUN-level unmap, initiator sees no LUN 3 → mount → Repair | **PASS** |
| 3 | ZFS child dataset variant (both signals) — placeholder DELETED | **PASS** |
| 4 | AHR fstab ordering: added on LUN placement, idempotent, and a normal boot orders by dependency | **PASS** |
| 5 | F12 — a disabled ANAS target gets a card | **PASS** |
| 6 | F13 — a zvol grow under a live session, through BOTH doors | **PASS** |
| 7 | F15 — the volume-destroy guidance | **PASS** |
| — | F14 — `deploy-anas.sh` installs the ordering drop-in | **PASS** |

### 0. The old build, and a power cycle that was not staged

`snapshot.sh pre-iscsi8` stops the VM, and `add-disk.sh` attaches the three AHR disks with
`--live` only — so the very first boot of this session was the F2 scenario, with the code that
does not handle it:

```
$ cat /proc/mdstat                     unused devices: <none>
$ ls -la /mnt/anas-ahr/lpahr/
-rw------- 1 root root 0 Aug 26 16:33 lpahrlun.raw        ← LIO created it at boot
$ cat …/core/fileio_0/lpahrlun/info
Status: ACTIVATED …  File: /mnt/anas-ahr/lpahr/lpahrlun.raw  Size: 536870912
$ GET /v1/iscsi/health   →  degraded false, missingLuns []
$ GET /v1/iscsi/targets  →  iqn.2026-08.anas-pve.anas:lp2  foreign  backing-not-anas-storage
```

A whole storage pool absent, an empty 512 MiB disk on the network, a healthy verdict, and the
ANAS target declared hands-off. Every symptom of F2, measured again before a line of the fix
ran.

### 1. The daemon-start quarantine

`deploy-anas.sh` (which now installs the drop-in — F14) restarted `anasd` into exactly that
state. The boot scan found it without being asked:

```
anasd[1928]: iscsi.quarantine target=iqn.2026-08.anas-pve.anas:lp2 lun=3 backstore=lpahrlun
             path=/mnt/anas-ahr/lpahr/lpahrlun.raw persistedSize=536870912 actualSize=0
             containingMount=/ expectedMount=unknown zeroSized=true wrongMount=false
             result=unmapped fileRemoved=false
anasd[1928]: iscsi stub quarantine: 1 placeholder LUN(s) taken offline …
```

and the node's answers changed to match the truth:

```
$ ls …/tpgt_1/lun/                     lun_0  lun_1  lun_2          ← LUN 3 unmapped, siblings intact
$ ls …/core/                           fileio_1 fileio_3 fileio_4   ← the stub backstore is gone
$ GET /v1/iscsi/health
    missingLuns [ lun 3, lpahrlun, backingExists FALSE ],  degraded TRUE,  stubLuns []
$ GET /v1/iscsi/targets   →  …:lp2  anas  backing-unresolved  ← ownership BACK
```

`expectedMount=unknown` is the honest limit of the AHR-detached case: with no md array there is
no pool, so nothing on the system can say where the file was supposed to live. Only the
size signal fires, so the 0-byte file is **kept** — one signal unmaps the LUN, two are needed
before ANAS deletes anything. The `missingLuns` card says so rather than claiming the path is
empty:

> LUN 3 'lpahrlun' … did not restore … That path holds a PLACEHOLDER the restore service
> created — a file of the right name that is not the image, which is why ANAS took the LUN
> offline. Mount the filesystem that should hold the image, then use Repair …

### 2. Unmount + restart, the F2 recipe verbatim

`systemctl stop rtslib-fb-targetctl` → `umount /mnt/anas-ahr/lpahr` → `systemctl start`. The
restore reused the leftover 0-byte file and reported `Result=success`, `ExecMainStatus=0`. The
FIRST `/v1/status` read after that is the discovering pass, and it says what happened:

```
CRITICAL  LUN 3 'lpahrlun' of target iqn.2026-08.anas-pve.anas:lp2 is a placeholder created by
          the restore service — its filesystem was not mounted, so /mnt/anas-ahr/lpahr/
          lpahrlun.raw holds no data (it is 0 bytes where the saved configuration says
          536870912). An initiator reading it sees an empty disk of the right size with the
          right serial. ANAS has taken it offline; mount the filesystem and use Repair …
```

The unmap is LUN-level, and rtslib removes the dependent MappedLUNs with it — both ACLs kept
exactly their other three:

```
$ ls …/tpgt_1/lun/                              lun_0 lun_1 lun_2
$ ls …/acls/iqn.1993-08.org.debian:01:ae3d…/    lun_0 lun_1 lun_2
$ ls …/acls/iqn.1993-08.org.debian:01:dead…/    lun_0 lun_1 lun_2
$ initiator, fresh login:   sdb lpzvol 2G   sdc lpsmall 256M   sdd lpfile 2G
                            ← three disks, and NO 512 MiB lpahrlun
```

Then `mount /mnt/anas-ahr/lpahr` + `POST /v1/iscsi/health/repair`:

```
completed  repaired[ lun 3, lpahrlun, serialReplayed true ]  stillMissing []  saved true
$ initiator after -R:   sdh 512M lpahrlun  8157f977-6f7e-4f38-a92d-15a91e891520
$ sha256sum /dev/sdh                          8264508bd3c58006…
$ sha256sum …/lpahrlun.raw                    8264508bd3c58006…   ← byte-identical
```

Same serial, same bytes, through the initiator.

### 3. The ZFS child-dataset variant — where both signals fire

`zfs unmount gtbackup/img2` with LUN 2 (`lpsmall`) backed by `/gtbackup/img2/lpsmall.raw`. The
restore created the placeholder on the PARENT dataset, which is the case a size check alone
would still catch but a size check alone could not safely clean up:

```
$ findmnt -T /gtbackup/img2/lpsmall.raw -o TARGET,SOURCE    /gtbackup  gtbackup
$ GET /v1/iscsi/health  →  stubLuns[0]
    persistedSize 268435456   actualSize 0
    containingMount /gtbackup   expectedMount /gtbackup/img2
    zeroSized true   wrongMount true   quarantined true   fileRemoved TRUE
$ ls -la /gtbackup/img2/                       (empty)
anasd: iscsi.quarantine … zeroSized=true wrongMount=true result=unmapped fileRemoved=true
```

`zfs mount gtbackup/img2` + Repair put LUN 2 back with `serialReplayed true`.

### 4. The AHR fstab ordering

`POST …/luns {kind: file, backing: lpahr}` — the moment an image LUN lands on the pool:

```
before   /dev/lpahr/lpahr-vol /mnt/anas-ahr/lpahr btrfs nofail,subvol=@data 0 0
after    /dev/lpahr/lpahr-vol /mnt/anas-ahr/lpahr btrfs nofail,subvol=@data,x-systemd.before=rtslib-fb-targetctl.service 0 0
second LUN on the same pool  →  `diff` says IDENTICAL
$ systemctl show 'mnt-anas\x2dahr-lpahr.mount' -p Before   Before=rtslib-fb-targetctl.service
```

A normal reboot then orders by DEPENDENCY rather than by luck (the 1.2 s margin GT-47 measured
was coincidence; this is not):

```
16:43:33.533949  Mounted mnt-anas\x2dahr-lpahr.mount - /mnt/anas-ahr/lpahr.
16:43:34.585985  Starting rtslib-fb-targetctl.service - Restore LIO kernel target configuration...
16:43:34.877906  Finished rtslib-fb-targetctl.service …
$ GET /v1/iscsi/health   →  degraded false, missing 0, stubs 0
```

The `post-iscsi8` snapshot then power-cycled the node one more time, and the ordering earned
its keep on a boot nobody staged — the AHR disks were re-attached while the guest was still
coming up, and the restore waited for the mount instead of racing it:

```
16:49:09.206347  Mounted mnt-anas\x2dahr-lpahr.mount - /mnt/anas-ahr/lpahr.
16:49:09.207452  Starting rtslib-fb-targetctl.service …          ← 1 ms later, BY DEPENDENCY
16:49:09.402851  Finished rtslib-fb-targetctl.service …
$ GET /v1/iscsi/health   →  degraded false, missing [], stubs 0
$ ls …/tpgt_1/lun/       →  lun_0 lun_1 lun_2 lun_3
$ dd if=/dev/sdg bs=1M count=4 | sha256sum          5d7934bcabafceb6…
$ dd if=…/lpahrlun.raw bs=1M count=4 | sha256sum    5d7934bcabafceb6…
```

No placeholder, no quarantine, no repair — the failure mode simply did not happen. That is the
point of design point 3: detection and quarantine are the safety net, the fstab ordering is
what keeps the node off it.

### 5. F12 — a target that is serving nothing

```
POST …/state {disable}  →  GET /v1/status
WARNING  iSCSI target iqn.2026-08.anas-pve.anas:lp2 is disabled — it is serving nothing, and
         its 6 LUNs are unreachable (LIO's enable flag is per target, not per LUN). Enable it
         from the iSCSI menu when you are ready.
POST …/state {enable}   →  no iscsi cards
```

The partial-image-restore reason rides on the retained job when there is one; there was no
failed restore in this session, so the card correctly carried no invented explanation.

### 6. F13 — one answer from both doors

```
iSCSI door,   1 session open,  PUT …/luns/0 {size: 3 GiB}      → 202, completed
    warning: "1 initiator is logged in. The volume grows live, but an initiator keeps showing
              the OLD size until it rescans (open-iscsi: `iscsiadm -m node -R`) …"
    initiator before -R:  sde 2G      after -R:  sde 3G        ← measured, again
Datasets door, same session, PUT …/datasets/sparse1 {volsize: 4 GiB}  → 202, completed
```

And the two things that are NOT a live grow are still refused, with reasons that differ:

```
PUT …/luns/1 {size} (file kind, session)  → 409 session-open, no confirm code
    "A file-backed LUN is resized by recreating its backstore (its size is fixed at creation),
     so it is refused under a live session …"
PUT …/luns/0 {size: 1 MiB}                → 409 shrink   (a shrink is refused AS a shrink,
                                             session or not — "log the initiator out" would
                                             have been misleading advice)
```

### 7. F15 — the destroy that ZFS refuses

On a fresh `gtbackup/i8vol` with two snapshots:

```
DELETE …/datasets/i8vol            → 409 CONFIRMATION_REQUIRED, warnings[] includes
  "Volume 'gtbackup/i8vol' has 2 snapshots (gtbackup/i8vol@r1, gtbackup/i8vol@r2) — ZFS will
   not destroy it while they exist. Destroy them first, or confirm again with Recursive to
   destroy gtbackup/i8vol and everything under it in one go. A recursive destroy is
   irreversible."
DELETE …/datasets/i8vol (confirmed, not recursive)  → job FAILED with the SAME sentence
```

No `use '-r'`, no `volume has children`, in either place.

### GT amendments (`docs/ISCSI-GROUND-TRUTH.md`)

14. **`luns delete lun<n>` removes that LUN's MappedLUNs from every ACL.** rtslib does the
    dependent delete, so a LUN-level unmap needs exactly the two commands `deleteIscsiLun`
    already runs — no ACL cleanup pass, and no leftover `mapped_lun<n>` directories. Verified
    on two ACLs with three sibling LUNs each.
15. **A by-hand `mount` of an fstab entry creates a mount unit systemd may collect.** Stopping
    `rtslib-fb-targetctl` (which the ordering drop-in orders after `local-fs.target`) took a
    hand-mounted AHR pool down with it, producing a THIRD unprompted F2 reproduction inside
    this proof. Not a product bug — a `nofail` mount started outside a boot transaction has
    nothing wanting it — but it is a trap for anyone testing by hand: mount with
    `systemctl start <unit>.mount`, or expect the mount to disappear under an unrelated stop.
16. **The stub verdict's mount signal is unavailable when the whole pool is gone.** With no md
    array there is no AHR topology, so `expectedMount` is unknown and only the size signal
    fires — which unmaps the LUN but deliberately leaves the 0-byte file. Mounting the pool
    then shadows it (`Directory … to mount over is not empty, mounting anyway`), which is
    harmless but leaves litter until someone unmounts. The ZFS-dataset case has both signals
    and cleans up after itself.

### Node state left behind (delta from the wave-2 section above)

- **`gtbackup/sparse1` is now 4 GiB** (was 2 GiB) — grown twice by the F13 legs, through both
  doors. A zvol cannot shrink back, and LUN 0 reports 4294967296.
- **The AHR pool's fstab line carries `x-systemd.before=rtslib-fb-targetctl.service`**, added
  by the LUN-placement path and left in place (the pool holds LUN 3).
- The stale 0-byte `lpahrlun.raw` placeholder under the mountpoint was removed by hand at the
  end; `/mnt/anas-ahr/lpahr/` holds the real 512 MiB image (`8264508bd3c58006…`), `photos` and
  `top`.
- Temporary objects removed again: LUNs 4/5 (`i8order`, `i8order2`) with their images, the
  volume `gtbackup/i8vol` and its two snapshots.
- `GET /v1/iscsi/health`: `degraded false`, nothing missing, no stubs, no disabled targets.
  Target `…:lp2` is `anas`, enabled, 4 LUNs with their original serials
  (`3183e69f…`, `2e69b404…`, `33907512…`, `8157f977…`). `saveconfig.json` sha256
  `4e92833d…`. The only dashboard warnings are the pre-existing `share`/`mount` ones from
  earlier sessions (`/testpool/*`, `/mnt/anas-ahr/stage`, `/mnt/anas-cifs-smoke`).
- **The `add-disk.sh` caveat still applies**: after any full stop, re-run
  `./test/stunt-node/add-disk.sh 1 && … 2 && … 3`. What has changed is what happens if you
  forget — ANAS now takes the placeholder LUN offline by itself and tells you, instead of
  serving an empty disk. The recovery is `add-disk.sh` ×3, `mount /mnt/anas-ahr/lpahr`, then
  Repair from the iSCSI menu.
