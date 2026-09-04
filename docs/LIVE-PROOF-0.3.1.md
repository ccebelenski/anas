# Live proof — 0.3.1 remediation (waves 1–4), plus the M3 ground-truth probe

Driven 2026-09-04 against the disposable stunt PVE 9 node `anas-pve` (192.168.200.50) running
the remediation build **`0.3.0+dev.96243b5`** (`/opt/anas`, deployed 01:44; HEAD `96243b5`,
the last of the wave-3/4 commits). Every call below went to the REAL daemon on its unix
socket `/run/anas/anasd.sock` with the identity headers
(`x-anas-user: liveproof@pam` / `x-anas-user-uid: 0` / `x-anas-request-id: <uuid>`) and confirm
retries via `x-anas-confirm`. Answers were compared against the system's own truth —
`targetcli ls`, configfs, `saveconfig.json`, `zfs get -Hp`, `findmnt`, `stat`, `lsblk -S`,
`iscsiadm`, `ss -lnt`, `dmesg`, `journalctl` — never against fixtures.

VM snapshot **`pre-031-liveproof`** taken before anything.

## Verdicts

| # | What | Verdict |
|---|---|---|
| **LP1** | #47 + M5 + M4 — every LUN delete confirm-gated; snapshot-honest destroy; bare pool refused | **PASS** (a, b, c) |
| **LP2** | #50 — exact volsize; the old rounding window can no longer hide a shrink | **PASS** |
| **LP3** | #48 K3 semantics + #49 picker data + R2 parent chain + new-LUN image restore | **PASS** |
| **LP4** | #51 — AHR rollback gets the held-by-LUN pre-flight | **PASS** |
| **LP5** | #54 — a FOREIGN target's stub is reported and never touched (staged live, with a control) | **PASS**, one finding routed |
| **LP6** | **M3 ground truth** — what LIO does to an established session on `np delete` | **ANSWERED** (see §LP6) |
| **LP7** | #46 — recurring tasks judge the target where it lives | **PASS** (loop-back remote; one limitation noted) |

**Findings: 1 MEDIUM (F1), 1 gap confirmed by design (F2 = M3's own subject), 3 LOW observations.**
No wave-1/2/3/4 fix failed. Nothing had to be preserved for inspection; the node was cleaned up.

### Pre-existing state cleaned before the round

The node came up with an orphaned LUN 3 (`lpahrlun`) on `…:lp2` whose AHR pool `lpahr` no
longer exists (its disks were removed in an earlier round), so `GET /v1/iscsi/health` reported
`degraded: true` and every iSCSI mutation was refused `degraded-restore`. That is correct
behaviour, not a defect; the orphan LUN and its two dead AHR `fstab` entries were removed by
hand (`targetcli … luns delete lun3`, `saveconfig`, `sed -i` on `/etc/fstab`) and health went
clean (`degraded: false`, `missingLuns: []`) before LP1 started. See **O3** for what those
`fstab` entries cost at boot.

---

## LP1 — #47 (U1), M5, M4

Staged: target `iqn.2026-09.anas-pve.anas:lp31` (one portal, one ACL) and a sparse zvol
`gtiscsi/lp31vol` (256 MiB), both created through the API.

### LP1c — M4: a bare pool is not a volume

```
POST /v1/iscsi/targets/…:lp31/luns  {"name":"lp31bare","kind":"zvol","backing":"gtiscsi"}
→ 409 {"reason":"not-a-volume",
       "message":"'gtiscsi' names a pool, not a volume — name a volume as <pool>/<volume>
                  (a pool itself has no /dev/zvol device to export)"}

POST … {"backing":"/dev/zvol/gtiscsi"}
→ 409 same reason, message quotes '/dev/zvol/gtiscsi'
```

Both spellings of the M4 hole are closed, at the route, before anything is created.

### LP1a — every delete is confirm-gated, and the backing survives

```
POST …/lp31/luns {"name":"lp31zv","kind":"zvol","backing":"gtiscsi/lp31vol"}
job completed {"index":0,"name":"lp31zv","serial":"ce306804-3123-4692-87a8-9fec5d522b8b",
               "backingPath":"/dev/zvol/gtiscsi/lp31vol",
               "attributes":{"emulateTpu":true,"emulateTpws":true,
                             "maxUnmapLbaCount":524288,"writeBack":false}}

$ targetcli /iscsi/…:lp31/tpg1/luns ls
  o- lun0 … [block/lp31zv (/dev/zvol/gtiscsi/lp31vol) (default_tg_pt_gp)]
```

**The delete with NO confirm header and NO query flags** — the exact call the pre-fix UI made
one-click:

```
DELETE /v1/iscsi/targets/…:lp31/luns/0
→ HTTP/1.1 409 Conflict
  x-anas-confirm-code: 2bb600b63ba0
  x-anas-confirm-expires: 2026-09-04T01:53:51.430Z
  {"code":"CONFIRMATION_REQUIRED",
   "message":"Deleting LUN 0 of 'iqn.2026-09.anas-pve.anas:lp31' is irreversible — the unit
              serial goes with it; the backing object is kept unless the resend sets
              destroyBacking",
   "warnings":[
     "The unit serial ce306804-… goes with it — any PVE volid or initiator configuration
      built on it breaks",
     "The backing object /dev/zvol/gtiscsi/lp31vol is kept unless you tick \"Also destroy\"
      (re-send with ?destroyBacking=true)",
     "If the backing is destroyed: the volume gtiscsi/lp31vol will be destroyed. Its
      snapshots are NOT destroyed with it — a volume that still has any is refused, so
      remove them on the Datasets screen first."]}
```

Resent with the code and **no flag**:

```
DELETE …/luns/0   (x-anas-confirm: 2bb600b63ba0)
→ 202; job completed {"index":0,"backstoreDeleted":"lp31zv","backingDestroyed":null}

$ targetcli /iscsi/…:lp31/tpg1/luns ls        [LUNs: 0]
$ targetcli /backstores/block ls              lp31zv is gone (gtiscsi_vol1, lpzvol remain)
$ zfs list -Hp -o name,volsize gtiscsi/lp31vol
  gtiscsi/lp31vol   268435456                ← the zvol SURVIVES
```

The flag is out of the code signature (the `datasets.ts:1538` rule): the same `{target, lun}`
code is valid whether or not the resend sets `destroyBacking`, and the warning list is what
discloses the difference. The audit line records the flag that was actually used:

```
audit: liveproof@pam submitted iscsi.lun.delete
  params {"target":"iqn.2026-09.anas-pve.anas:lp31","lun":1,"destroyBacking":true}
```

### LP1b — M5: the destroy warning's promise is now pre-checked

LUN recreated (`serial 377454ed-…`), then `gtiscsi/lp31vol@lpsnap31` taken through the API.

```
DELETE …/luns/0?destroyBacking=true          (no confirm header)
→ 409, and NO x-anas-confirm-code header at all
  {"reason":"zvol-has-snapshots",
   "message":"The volume gtiscsi/lp31vol has 1 snapshot (gtiscsi/lp31vol@lpsnap31).
              Destroying the backing destroys the VOLUME only — ANAS never sweeps snapshots
              away as a side effect, and 'zfs destroy' refuses a volume that still has any.
              Remove them on the Datasets screen first, or delete the LUN without
              \"Also destroy\" and keep the volume. This refusal has no confirm bypass."}
```

The snapshot is **named**, the refusal is minted **before** the confirm gate (so no code is
issued and no unmap happens first), and the old failure mode — unmap, then `zfs destroy` fails,
then no `saveconfig` — cannot be reached. Snapshot removed, retried:

```
DELETE …/luns/0?destroyBacking=true  → 409 CONFIRMATION_REQUIRED, code 4628e9c086cb
DELETE …/luns/0?destroyBacking=true  (x-anas-confirm: 4628e9c086cb)
→ 202; job completed {"index":0,"backstoreDeleted":"lp31zv",
                      "backingDestroyed":"gtiscsi/lp31vol"}

$ zfs list -Hp -o name -r gtiscsi    gtiscsi, gtiscsi/images, gtiscsi/vol1   ← lp31vol gone
$ targetcli /iscsi/…:lp31/tpg1/luns ls   [LUNs: 0]
```

---

## LP2 — #50, the rounding window

A zvol asked for **1 300 000 000 bytes**; ZFS rounded it up to a `volblocksize` multiple:

```
$ zfs get -Hp volsize,volblocksize gtiscsi/lp32round
  gtiscsi/lp32round  volsize        1300004864  local
  gtiscsi/lp32round  volblocksize   16384       default

$ zfs list -H  -o name,volsize gtiscsi/lp32round     gtiscsi/lp32round   1.21G   ← the pre-fix source
$ zfs list -Hp -o name,volsize gtiscsi/lp32round     gtiscsi/lp32round   1300004864
```

`1.21G` parses back to **1 299 227 607** — 777 257 bytes BELOW the true size. That difference
is the whole defect.

**The API read model is exact:**

```
GET /v1/pools/gtiscsi/datasets  →  {"name":"gtiscsi/lp32round","type":"volume",
                                    "volsize":1300004864,"volblocksize":16384,"sparse":true}
```

**Both values inside the old window are now refused as shrinks:**

```
PUT /v1/pools/gtiscsi/datasets/lp32round {"properties":{"volsize":1299500000}}
→ 409 {"reason":"shrink","message":"Volume 'gtiscsi/lp32round' is 1300004864 bytes; a volsize
        of 1299500000 bytes would SHRINK it. ZFS would truncate it silently and anything
        written past the new end — a partition table, a filesystem, a LUN's data — would be
        gone. Destroy and recreate the volume at the smaller size instead. This refusal has
        no confirm bypass."}

PUT … {"properties":{"volsize":1299227607}}     (exactly the old 1.21G parse)
→ 409 same reason, message quotes 1299227607 against 1300004864
```

Under the pre-fix code the gate compared against 1 299 227 607, so **both** of those would have
read as grows and ZFS would have truncated the volume. **A real grow still works:**

```
PUT … {"properties":{"volsize":1400012800}}
→ 202; job completed {"dataset":"gtiscsi/lp32round","applied":["volsize=1400012800"],"warnings":[]}
$ zfs get -Hp volsize gtiscsi/lp32round     1400012800
  GET /v1/pools/gtiscsi/datasets            volsize 1400012800
```

(See **O1** for the one rough edge met on the way: an unaligned grow.)

---

## LP3 — #48 (K3 semantics), #49 (picker data), R2, and the new-LUN image restore

A real files backup was run first — `POST /v1/backup/tasks/lp-files/run`, task `lp-files`,
repo `lp-repo` (PBS `localhost:8007`, datastore `anastest-store`, namespace `gtrestore`):

```
job completed  sources[0] {"consistency":"snapshot",
  "reason":"/gtbackup/hl is on the ZFS dataset gtbackup; the run takes a recursive snapshot and
            backs up from /gtbackup/.zfs/snapshot/<snapshot>","backend":"zfs","target":"gtbackup"}
  snapshots[0]  gtbackup@anas-backup-lp-files-1788486795 (recursive)

GET /v1/backup/tasks/lp-files/snapshots
  host/lp-files/2026-09-04T01:53:15Z   hl.pxar.didx 314574576  catalog.pcat1.didx 170
```

### R2 — a destination whose PARENT does not exist

```
$ ls -d /gtbackup/lp3new        No such file or directory

POST /v1/backup/restore
  {"kind":"files","repo":"lp-repo","ns":"gtrestore",
   "snapshot":"host/lp-files/2026-09-04T01:53:15Z","archive":"hl.pxar",
   "selections":["/rootfile","/a"],
   "target":{"mode":"newLocation","path":"/gtbackup/lp3new/deep/er"}}
→ 202; job completed
   {"mode":"newLocation","target":"/gtbackup/lp3new/deep/er","merge":false,
    "completeLine":"restore complete (300.002 MiB processed in 4.4s, average 68.344 MiB/s)",
    "status":"completed","restored":["/rootfile","/a"],"missing":[],"warnings":[]}

$ find /gtbackup/lp3new -maxdepth 4
  /gtbackup/lp3new
  /gtbackup/lp3new/deep
  /gtbackup/lp3new/deep/er
  /gtbackup/lp3new/deep/er/a{/foreign.txt,/x,/plain.txt,/z}
  /gtbackup/lp3new/deep/er/rootfile
```

The pre-flight now probes the nearest EXISTING ancestor, so the whole chain is created by the
client and the write test no longer refuses a two-deep new path. `ls -a` on the destination
shows **no `.anas-restore-partial` marker** left behind (R3).

### Merge into the now-existing directory

```
POST /v1/backup/restore  … selections ["/b"] … same newLocation path
→ 409  x-anas-confirm-code: 50727cf9617c
   {"code":"CONFIRMATION_REQUIRED",
    "message":"'/gtbackup/lp3new/deep/er' already exists: restoring into it overwrites files
               with the same names and keeps everything else. Confirm to proceed."}

  resend with the code → 202; job completed
   warnings:["The chosen directory '/gtbackup/lp3new/deep/er' already existed, so this restore
              MERGED into it: files with the same names were replaced, and everything else
              under it was left exactly as it was."]

$ ls -a /gtbackup/lp3new/deep/er     .  ..  a  b  rootfile     ← merged, 'a' untouched
```

### #49 — the pickers' data

The three reads the new-LUN restore dialog fills its pickers from all return rows:

```
GET /v1/backup/lun-sources    3 LUNs, each with kind/path/serial/size/backingExists and a
                              per-LUN consistency verdict (zvol snapdev for lpzvol; parent
                              dataset snapshot for lpfile; child dataset for lpsmall)
GET /v1/pools                 gtbackup (pveStorages []), gtiscsi (pveStorages [])
GET /v1/ahr                   [] at this point; later in the round, with LP4's pool built,
                              it returned lp34 with "mounted": true — the AHR branch of the
                              image-file list
```

### Whole-image restore AS A NEW LUN

PBS was healthy, so the `backup2.10` door was driven end to end against the existing
`host/lp-img/2026-08-26T15:05:55Z` snapshot:

```
POST /v1/backup/restore
  {"kind":"image","repo":"lp-repo","ns":"gtrestore",
   "snapshot":"host/lp-img/2026-08-26T15:05:55Z","archive":"ahrlun.img",
   "target":{"mode":"newLun","targetIqn":"iqn.2026-09.anas-pve.anas:lp31","name":"lp31rest",
             "backing":{"kind":"file","dataset":"gtiscsi/images"}}}
→ 409  x-anas-confirm-code: 555e980ab230, four warnings including
   "This creates a NEW LUN 'lp31rest' backed by /gtiscsi/images/lp31rest.raw at exactly the
    image's size (536870912 bytes), mapped at the next free index … Nothing that exists is touched."
   "The new LUN gets a FRESH unit serial: a restored copy is a NEW disk …"

  resend → 202; job completed
  {"snapshot":"host/lp-img/2026-08-26T15:05:55Z","archive":"ahrlun.img",
   "targetIqn":"iqn.2026-09.anas-pve.anas:lp31","lunIndex":0,
   "targetPath":"/gtiscsi/images/lp31rest.raw","imageSize":536870912,
   "bytesWritten":536870912,"complete":true,
   "targetDisabled":false,"targetReEnabled":false,
   "newLun":{"targetIqn":"iqn.2026-09.anas-pve.anas:lp31","index":0,"name":"lp31rest",
             "serial":"63c4714f-7f15-46f6-b569-82c2d4b8e6bc",
             "backingPath":"/gtiscsi/images/lp31rest.raw"},
   "duration":"restore complete (512 MiB processed in 1.2s, average 442.518 MiB/s)"}
```

**The job result carries the new LUN's identity** (`newLun.index/name/serial/backingPath`) —
which is what K3's `showNewLunResult` needs in order to say what was made rather than "done",
and `targetDisabled:false` confirms the new-LUN path never took the target offline.

---

## LP4 — #51, the AHR rollback pre-flight

An AHR-1 pool `lp34` was built through the API on three freshly attached 2 GiB virtual disks
(confirm-gated create, `md` band `lp34-r1`, LVM, btrfs `@data`/`@snapshots`):

```
POST /v1/ahr {"name":"lp34","tier":"ahr1","disks":[…ANAS_HOT20,21,22]}
→ 409 CONFIRMATION_REQUIRED, code e431069fb858 → resend → 202
   job completed {"created":"lp34","mountpoint":"/mnt/anas-ahr/lp34","arrays":["lp34-r1"]}
```

An image-file LUN was put on it, then the pool was snapshotted:

```
POST /v1/iscsi/targets/…:lp31/luns {"name":"lp34lun","kind":"file","backing":"lp34","size":134217728}
  → {"index":1,"name":"lp34lun","serial":"c4c029bf-…","backingPath":"/mnt/anas-ahr/lp34/lp34lun.raw"}
POST /v1/ahr/lp34/snapshots {"name":"lp34snap"}   → {"pool":"lp34","snapshot":"lp34snap"}
```

**The rollback, with no confirm header:**

```
POST /v1/ahr/lp34/snapshots/lp34snap/rollback  {}
→ HTTP/1.1 409 Conflict            ← and NO x-anas-confirm-code header
  {"reason":"held-by-lun",
   "message":"Rolling back AHR pool 'lp34' is refused: it is held by iSCSI LUN 1 'lp34lun' of
              target iqn.2026-09.anas-pve.anas:lp31 (/mnt/anas-ahr/lp34/lp34lun.raw). Nothing
              underneath stops this on its own — the operation would either fail with a bare
              'busy' error or succeed silently and corrupt what the initiator sees. Delete
              LUN 1 ('lp34lun') of target iqn.2026-09.anas-pve.anas:lp31 from the iSCSI screen
              first, or delete it with destroyBacking=true to remove the backing object in the
              same step. This refusal has no confirm bypass."}
```

**No confirm code was minted** — the pre-flight runs before the gate, exactly like its ZFS
twin. The same claim is on the read model:

```
GET /v1/ahr  lp34.heldByLun = {"targetIqn":"…:lp31","index":1,"name":"lp34lun",
                               "backingPath":"/mnt/anas-ahr/lp34/lp34lun.raw",
                               "connectedInitiators":[],"detail":"held by iSCSI LUN 1 …"}
GET /v1/iscsi/claims  lists all claims on the node with the same ready-made sentence
```

**With the LUN gone, the normal confirm flow works:**

```
DELETE …/luns/1?destroyBacking=true → confirm → 202
  {"index":1,"backstoreDeleted":"lp34lun","backingDestroyed":"/mnt/anas-ahr/lp34/lp34lun.raw"}

POST /v1/ahr/lp34/snapshots/lp34snap/rollback {}
→ 409  x-anas-confirm-code: bbb8efbf8d6b, three warnings (brief unmount / nothing destroyed,
       @data preserved as pre-rollback-<ts> / changes since the snapshot are no longer live)
  resend → 202; job completed
  {"pool":"lp34","rolledBackTo":"lp34snap","preserved":"pre-rollback-2026-09-04T020201Z"}

$ findmnt /mnt/anas-ahr/lp34
  /mnt/anas-ahr/lp34  /dev/mapper/lp34-lp34--vol[/@data]  btrfs  rw,…,subvol=/@data
$ btrfs subvolume list /mnt/anas-ahr/lp34
  ID 256 … path @snapshots/pre-rollback-2026-09-04T020201Z
  ID 257 … path @snapshots
  ID 258 … path @snapshots/lp34snap
  ID 259 … path @data
```

The rollback restored `lp34lun.raw` from inside the snapshot (the snapshot was taken while the
LUN existed) — which is precisely the divergence the gate exists to prevent from happening
under LIO's open file descriptor.

---

## LP5 — #54 (C1), staged live

The two-signal stub verdict WAS stageable on real hardware. Sequence:

```
zfs create -o mountpoint=/gtbackup/lp35img gtbackup/lp35img
truncate -s 67108864 /gtbackup/lp35img/lp35.raw ; dd 1 MiB of random into it
targetcli /backstores/fileio create name=lp35stub file_or_dev=/gtbackup/lp35img/lp35.raw size=67108864
   → "/gtbackup/lp35img/lp35.raw exists, using its size (67108864 bytes) instead"
targetcli /iscsi create iqn.2000-05.com.example:lp35            ← a FOREIGN IQN
targetcli /iscsi/iqn.2000-05.com.example:lp35/tpg1/luns create /backstores/fileio/lp35stub
targetcli saveconfig
```

ANAS classified it correctly before anything else:

```
GET /v1/iscsi/targets → {"iqn":"iqn.2000-05.com.example:lp35","ownership":"foreign",
  "ownershipReason":"iqn-not-anas",
  "ownershipDetail":"IQN 'iqn.2000-05.com.example:lp35' was not generated by ANAS
                     (an ANAS target's naming authority ends in '.anas')"}
```

Then the real image was taken away the way a boot does it — stop the restore service (which
clears the tree), unmount the child dataset, start it again:

```
systemctl stop rtslib-fb-targetctl ; zfs umount gtbackup/lp35img
$ findmnt -n -o TARGET,SOURCE -T /gtbackup/lp35img      /gtbackup  gtbackup     ← now the PARENT
systemctl start rtslib-fb-targetctl

$ stat -c "%n size=%s" /gtbackup/lp35img/lp35.raw       /gtbackup/lp35img/lp35.raw size=0
$ cat /sys/kernel/config/target/core/fileio_7/lp35stub/info
  Status: ACTIVATED  Max Queue Depth: 128  SectorSize: 512  HwMaxSectors: 16384
          TCM FILEIO ID: 0  File: /gtbackup/lp35img/lp35.raw  Size: 67108864  Mode: Buffered-WCE
```

Wave-2's **F2** reproduced exactly: `targetctl restore` created a 0-byte placeholder and LIO
serves it as a healthy 64 MiB disk.

**The health read (which runs the quarantine) reports it and does not act:**

```
$ targetcli ls > /tmp/lp35-before.txt ; sha256sum → 628b07b2888fd1df9948771993008ba409d1d834dee4dd1dce5b44ed8fedd356

GET /v1/iscsi/health
  stubLuns:[{"targetIqn":"iqn.2000-05.com.example:lp35","tpgTag":1,"lunIndex":0,
             "backstoreName":"lp35stub","backingPath":"/gtbackup/lp35img/lp35.raw",
             "persistedSize":67108864,"actualSize":0,
             "containingMount":"/gtbackup","expectedMount":"/gtbackup/lp35img",
             "zeroSized":true,"wrongMount":true,
             "quarantined":false,"fileRemoved":false}]
  degraded:true

$ targetcli ls > /tmp/lp35-after.txt ; sha256sum → 628b07b2888fd1df9948771993008ba409d1d834dee4dd1dce5b44ed8fedd356
$ diff /tmp/lp35-before.txt /tmp/lp35-after.txt      (identical — nothing was unmapped)
$ stat -c "%n size=%s" /gtbackup/lp35img/lp35.raw    size=0   (the file was not unlinked)

journalctl -u anasd:
  iscsi.quarantine target=iqn.2000-05.com.example:lp35 lun=0 backstore=lp35stub
    path=/gtbackup/lp35img/lp35.raw result=skipped
    detail=foreign target — hands-off (iqn-not-anas: IQN 'iqn.2000-05.com.example:lp35' was
    not generated by ANAS (an ANAS target's naming authority ends in '.anas'))
```

Both stub signals fired (`zeroSized` AND `wrongMount`), the card is reported in full, the tree
is byte-identical, and journald carries `result=skipped` with the ownership derivation that
decided it — exactly the C1 contract.

### The control — the same shape on an ANAS-owned target IS quarantined

To prove the skip is the ownership gate and not a dead detector, the foreign target was
removed and the shape restaged on `…:lp31` with an ANAS LUN whose dataset `gtbackup/lp35b`
was not mounted:

```
POST …/lp31/luns {"name":"lp35anas","kind":"file","backing":"gtbackup/lp35b","size":67108864}
  → {"index":1,"serial":"efa279fc-…","backingPath":"/gtbackup/lp35b/lp35anas.raw"}
$ findmnt -n -o TARGET -T /gtbackup/lp35b/lp35anas.raw     /gtbackup    ← the PARENT dataset

GET /v1/iscsi/health
  stubLuns:[{"targetIqn":"iqn.2026-09.anas-pve.anas:lp31","lunIndex":1,
             "backstoreName":"lp35anas","persistedSize":67108864,"actualSize":67108864,
             "containingMount":"/gtbackup","expectedMount":"/gtbackup/lp35b",
             "zeroSized":false,"wrongMount":true,
             "quarantined":true,"fileRemoved":false}]

$ targetcli /iscsi/…:lp31/tpg1/luns ls    [LUNs: 1]   ← lun1 unmapped, lun0 untouched
$ ls -la /gtbackup/lp35b/                 lp35anas.raw still there, 67108864 bytes

journalctl -u anasd:
  iscsi.quarantine target=iqn.2026-09.anas-pve.anas:lp31 lun=1 backstore=lp35anas
    path=/gtbackup/lp35b/lp35anas.raw persistedSize=67108864 actualSize=67108864
    containingMount=/gtbackup expectedMount=/gtbackup/lp35b zeroSized=false wrongMount=true
    result=unmapped fileRemoved=false
```

Unmapped, and the file **kept** — only the conjunction of both signals licenses an unlink, and
here only `wrongMount` fired. The documented rule holds live in both directions.

---

## LP6 — the M3 ground-truth probe (the headline)

**Question:** what does LIO do to an ESTABLISHED session when its portal is deleted? GT-37
covered only new logins.

**Setup.** `open-iscsi` 2.1.11-1+deb13u2 was already installed; `iscsid` was started. A
two-portal target was created through the API — portal **A = 127.0.0.1:3260** (the one to be
removed) and portal **B = 192.168.200.50:3260** (kept):

```
POST /v1/iscsi/targets {"name":"lp36","portals":[{"address":"127.0.0.1","port":3260},
                                                 {"address":"192.168.200.50","port":3260}],
                        "auth":"none","acls":[{"initiatorIqn":"iqn.1993-08.org.debian:01:ae3d2ec18ad"}]}
→ job completed {"iqn":"iqn.2026-09.anas-pve.anas:lp36","portals":2,"acls":1,
                 "removedDefaultPortal":false,"warnings":[]}

$ ls /sys/kernel/config/target/iscsi/…:lp36/tpgt_1/np/
  127.0.0.1:3260
  192.168.200.50:3260
$ ss -lnt | grep 3260
  LISTEN 0 256      127.0.0.1:3260  0.0.0.0:*
  LISTEN 0 256 192.168.200.50:3260  0.0.0.0:*
```

LIO accepts a loop-back portal alongside a LAN portal on the same target with no complaint,
and SendTargets on either returns both. A 128 MiB zvol LUN (`lp36lun`, serial
`a57361fb-e712-4fc1-a54c-ed83f8fedb0b`) was mapped.

**Login through portal A, and the before-state:**

```
$ iscsiadm -m node -T …:lp36 -p 127.0.0.1:3260 --login
  Login to [iface: default, target: iqn.2026-09.anas-pve.anas:lp36, portal: 127.0.0.1,3260] successful.

$ iscsiadm -m session
  tcp: [1] 127.0.0.1:3260,1 iqn.2026-09.anas-pve.anas:lp36 (non-flash)

$ cat /sys/kernel/config/target/iscsi/…:lp36/tpgt_1/acls/*/info
  InitiatorName: iqn.1993-08.org.debian:01:ae3d2ec18ad
  InitiatorAlias: anas-pve
  LIO Session ID: 1   ISID: 0x00 02 3d 00 00 01  TSIH: 1  SessionType: Normal
  Session State: TARG_SESS_STATE_LOGGED_IN
  ----------------------[iSCSI Connections]-------------------------
  CID: 0  Connection State: TARG_CONN_STATE_LOGGED_IN
     Address 127.0.0.1 TCP  StatSN: 0xa90f80fc

  GET /v1/iscsi/sessions → 1 session, connections[0] {"cid":0,"address":"127.0.0.1",
                            "state":"TARG_CONN_STATE_LOGGED_IN"}, mappedLuns [0]
$ lsblk -S   sde  LIO-ORG  lp36lun  a57361fb-e712-4fc1-a54c-ed83f8fedb0b
```

4 MiB of random data was written through the session and read back
(`sha256 68e038cd675f56f84d5dbffff106c0e6022d83cc22fe1638f21eab6f923f7e62`, matching), then
`dmesg -C`.

**The mutation — remove portal A through the ANAS API, keep B:**

```
PUT /v1/iscsi/targets/iqn.2026-09.anas-pve.anas:lp36 {"portals":[{"address":"192.168.200.50","port":3260}]}
→ 202 (no confirm gate, no 409); job completed
  {"iqn":"iqn.2026-09.anas-pve.anas:lp36","portalsAdded":0,"portalsRemoved":1,
   "aclsAdded":0,"aclsRemoved":0,"credentialsUpdated":0,"authChanged":false,
   "warnings":[]}
```

**AFTER — raw evidence, verbatim:**

```
$ ls /sys/kernel/config/target/iscsi/…:lp36/tpgt_1/np/
  192.168.200.50:3260
$ ss -lnt | grep 3260
  LISTEN 0 256 192.168.200.50:3260  0.0.0.0:*          ← the 127.0.0.1 listener is GONE

$ iscsiadm -m session
  tcp: [1] 127.0.0.1:3260,1 iqn.2026-09.anas-pve.anas:lp36 (non-flash)

$ cat /sys/kernel/config/target/iscsi/…:lp36/tpgt_1/acls/*/info
  LIO Session ID: 1   ISID: 0x00 02 3d 00 00 01  TSIH: 1  SessionType: Normal
  Session State: TARG_SESS_STATE_LOGGED_IN
  ----------------------[iSCSI Connections]-------------------------
  CID: 0  Connection State: TARG_CONN_STATE_LOGGED_IN
     Address 127.0.0.1 TCP  StatSN: 0xa90f8137          ← StatSN advanced: still transacting

  GET /v1/iscsi/sessions → session count: 1, same sid/state/address/mappedLuns

$ dmesg
  (EMPTY — not one kernel line, target side or initiator side)

$ dd if=/dev/sde bs=1M count=4 | sha256sum
  68e038cd675f56f84d5dbffff106c0e6022d83cc22fe1638f21eab6f923f7e62   ← identical
$ dd if=/tmp/lp36.bin of=/dev/sde bs=1M seek=8 conv=fsync   → write-after-removal OK
$ lsblk -S   sde  LIO-ORG  lp36lun  a57361fb-…              ← same disk, same serial
```

**Re-login, through the removed portal and through the surviving one:**

```
(still logged in) $ iscsiadm -m node -T …:lp36 -p 127.0.0.1:3260 --login
  iscsiadm: default: 1 session requested, but 1 already present.

$ iscsiadm -m node -T …:lp36 -p 127.0.0.1:3260 --logout
  Logout of [sid: 1, target: …:lp36, portal: 127.0.0.1,3260] successful.

$ iscsiadm -m node -T …:lp36 -p 127.0.0.1:3260 --login          ← the REMOVED portal
  iscsiadm: Could not login to [iface: default, target: iqn.2026-09.anas-pve.anas:lp36,
                                portal: 127.0.0.1,3260].
  iscsiadm: initiator reported error (8 - connection timed out)
  iscsiadm: Could not log into all portals
  exit=8                                    (took ~2 min — iscsid's own retry ladder)

$ iscsiadm -m node | grep lp36               ← the initiator's node records, UNCHANGED
  127.0.0.1:3260,1 iqn.2026-09.anas-pve.anas:lp36
  192.168.200.50:3260,1 iqn.2026-09.anas-pve.anas:lp36

$ iscsiadm -m node -T …:lp36 -p 192.168.200.50:3260 --login     ← the SURVIVING portal
  Login to [… portal: 192.168.200.50,3260] successful.   exit=0
  $ iscsiadm -m session
    tcp: [2] 192.168.200.50:3260,1 iqn.2026-09.anas-pve.anas:lp36 (non-flash)

$ iscsiadm -m discovery -t sendtargets -p 127.0.0.1:3260
  iscsiadm: cannot make connection to 127.0.0.1: Connection refused          (x6)
  iscsiadm: connection login retries (reopen_max) 5 exceeded
  iscsiadm: Could not perform SendTargets discovery: iSCSI PDU timed out
  exit=11
```

### The answer, and what it means for M3

**An established session SURVIVES `np delete` completely intact.** LIO tears down only the
listening socket; the accepted TCP connection, the session, the mapped LUNs, the SCSI device
and read/write I/O all continue unchanged, and **the kernel emits nothing** — no target-side
message, no initiator-side message. The connection's `Address` in `acls/<iqn>/info` still names
the deleted portal, so ANAS's own session view keeps reporting a session on an address that no
longer listens.

So M3's hazard is not a session kill. It is a **latent reconnect trap**: everything looks
healthy until the next reconnect — an initiator reboot, an `iscsid` restart, a network blip,
`node.startup=automatic` — at which point the login goes to the recorded portal, hangs through
iscsid's retry ladder (error 8, ~2 minutes here) and fails, while a login through the surviving
portal works fine. The initiator's own node records are not updated by anything ANAS does.

**Recommended shape for M3** (the plan left this open): a hard refusal is wrong — nothing
breaks at the moment of the edit, and refusing would block legitimate portal cleanup. The right
gate is a **confirm with warnings** on removing a portal that currently carries a live
connection, naming the initiator(s) whose connection is on that address, saying that the session
keeps running but the next reconnect through that address will fail, and that the initiator's
own portal record must be updated on its side. That matches the ACL-removal gate's shape and
the "stale record with no kernel message" wording ANAS already uses for target delete.

**FINDING F2 (the gap M3 names, now measured):** today the edit returns `portalsRemoved: 1,
warnings: []` — the operator is told nothing at all, and the one signal that would let a UI say
something (a session whose connection address is the removed portal) is already in
`GET /v1/iscsi/sessions`.

---

## LP7 — #46, judged where the target lives

The stunt node's own SSH loop-back was usable, so a "remote" pointing at the node itself was
registered:

```
POST /v1/replication/remotes/test?pin=true {"name":"lpself","host":"127.0.0.1","port":22,"user":"root"}
→ {"stage":"ok","zfsVersion":"zfs-2.4.3-pve1",
   "fingerprint":"SHA256:cK6eiuFda2YyfG0OhIW2enps+PVjqzR1gvXC3b/dFao"}

POST /v1/replication/remotes {"expectedVersion":5,
      "remote":{"name":"lpself","host":"127.0.0.1","port":22,"user":"root"}}
→ 202; job completed {"created":"lpself","version":6}
```

```
POST /v1/replication/tasks
  {"name":"lp37ok","source":{"pool":"gtbackup","dataset":"cdm"},
   "target":{"pool":"gtiscsi","dataset":"lp37","location":{"kind":"remote","name":"lpself"}},
   "schedule":"Mon *-*-* 04:00:00","snapshotFirst":true,"enabled":true}
→ 202; job completed {"created":"lp37ok"}          ← ACCEPTED

POST /v1/replication/tasks  … "target":{"pool":"nosuchpool", … location remote lpself}
→ 400 {"code":"VALIDATION_ERROR",
       "message":"Target pool 'nosuchpool' does not exist on remote 'lpself'"}   ← NAMES the remote
```

One extra case distinguishes the fix from the stage-1 guard it replaced, which a loop-back on
its own cannot: a pool that **does** exist locally, behind a location that is not resolvable.
Pre-fix this was accepted (the local `zpool list` said yes) and failed at 03:00.

```
POST /v1/replication/tasks  … "target":{"pool":"gtbackup", …,
                                        "location":{"kind":"peer","name":"nosuchnode"}}
→ 400 {"message":"peer 'nosuchnode' is not a known cluster node"}
```

**Limitation, stated honestly:** a loop-back remote has the same pools as the local node, so
the positive case cannot by itself prove the existence check ran remotely rather than locally.
The negative case's wording (`… does not exist on remote 'lpself'`) and the peer case above are
the distinguishing evidence available on one node. A two-node proof belongs on the fleet.

---

## Findings

### F1 — MEDIUM — a foreign target's stub deadlocks ALL ANAS iSCSI management, with no in-product way out

Discovered while staging LP5, and a direct consequence of the (correct) #54 fix. While the
foreign stub was present:

```
GET /v1/iscsi/health   degraded: true, stubLuns[1] (quarantined:false — hands-off, correct)

POST /v1/iscsi/targets/…:lp31/luns   (an ordinary ANAS mutation on an unrelated ANAS target)
→ 409 {"reason":"stub-backing",
       "message":"The live iSCSI configuration is serving 1 LUN over a PLACEHOLDER file the
                  restore service created because the filesystem was not mounted: LUN 0 of
                  iqn.2000-05.com.example:lp35 … ANAS takes such a LUN offline and leaves the
                  saved record intact so Repair can put it back, and refuses every other
                  mutation meanwhile — a 'targetcli saveconfig' now would write the loss into
                  /etc/rtslib-fb-target/saveconfig.json permanently. Mount the filesystem,
                  then use Repair."}

POST /v1/iscsi/health/repair {}
→ 409 {"reason":"nothing-to-repair",
       "message":"The live iSCSI configuration already matches the saved one — there is no
                  restore hole to repair."}
```

Three things are wrong together:

1. The refusal's own text says *"ANAS takes such a LUN offline … and refuses every other
   mutation meanwhile"*. For a foreign stub ANAS deliberately never takes it offline, so
   *meanwhile* never ends.
2. Repair — the exit the message points at — answers `nothing-to-repair`, because the saved
   and live trees do match; the stub is not a hole.
3. Every ANAS iSCSI mutation on the node is refused, on every ANAS-owned target, because of a
   LUN ANAS has correctly decided is not its business. The only way out is `targetcli` by hand,
   outside the product.

No data is at risk; the cost is a total management lockout on a node where someone else's
target has a placeholder LUN (a hands-off target whose filesystem did not mount — the same
accident story `iscsi.8` exists for). This is the concrete case the plan's **C2 ruling** has to
settle: the saveconfig hazard that motivates the refusal is real, but it cannot be the whole
answer when ANAS has ruled the offending LUN out of scope. Options worth writing down:
scope the refusal to stubs ANAS could act on, keep a warning for the rest; or give the operator
an explicit, confirm-gated "quarantine this foreign stub anyway" door.

### F2 — the M3 gap, now measured (see §LP6)

Removing a portal that carries a live connection returns `portalsRemoved: 1, warnings: []`.
The session survives, so no refusal is warranted — but nothing tells the operator that the
initiator's next reconnect through that address will fail, and the fact needed to say so is
already in `GET /v1/iscsi/sessions`. Recommended: a confirm-with-warnings gate, wording as in
§LP6.

### O1 — LOW — an unaligned grow fails as a job, not as a boundary error

`zfs create` rounds a volsize up to the next `volblocksize` multiple; `zfs set volsize=` does
not. The create door therefore accepts `1300000000` (and stores `1300004864`) while the grow
door accepts the same shape and fails in the job:

```
PUT /v1/pools/gtiscsi/datasets/lp32round {"properties":{"volsize":1400000000}}
→ 202; job FAILED
  {"code":"JOB_FAILED",
   "message":"cannot set property for 'gtiscsi/lp32round': 'volsize' must be a multiple of
              volume block size (16K)"}
```

`1400012800` (aligned) then worked. Parallel construction says the grow door should do what the
create door does — round up to the volume's `volblocksize` (the value is already in the read
model) — or refuse at the boundary with a 400 naming the block size, rather than surfacing a
raw ZFS error out of a 202.

### O2 — LOW — a file LUN can be created onto a configured-but-UNMOUNTED dataset

`POST …/luns {"kind":"file","backing":"gtbackup/lp35b"}` succeeded while `gtbackup/lp35b` was
not mounted: ANAS resolved the dataset's mountpoint and created a full-size image in that
directory, which belongs to the PARENT dataset. The stub quarantine caught it on the next
health read (`wrongMount: true` → `result=unmapped`), so the safety net works — but the create
door had all the facts and let it through. Same shape as the standing "backup source guard"
idea: refuse an archive/backing path on a configured-but-unmounted mount at the door.

### O3 — LOW (environment/boot ordering) — a permanently-absent AHR device delays the LIO restore

The node's two orphaned AHR `fstab` entries carried
`nofail,…,x-systemd.before=rtslib-fb-targetctl.service` (the `iscsi.8` ordering option) for LVs
that no longer exist. `nofail` keeps the mount from failing the boot, but the ordering edge
still makes `rtslib-fb-targetctl.service` — and `multi-user.target` — wait behind the mount job,
which waits on its `.device` job:

```
$ systemctl list-jobs
  83  mnt-anas\x2dahr-lpahr.mount    start waiting
  84  dev-lpahr-lpahr\x2dvol.device  start running
  194 rtslib-fb-targetctl.service    start waiting
  16  multi-user.target              start waiting
```

It cleared on its own (the device job timed out; iSCSI was serving ~90 s after boot), so this
is a delay, not a hang — but on a node where an AHR pool's disks are pulled, every iSCSI LUN on
that node comes back ~90 s late for a reason nothing announces. Worth one sentence in the AHR
ordering comment, and worth considering `x-systemd.device-timeout=` alongside the `before=`.

---

## Cleanup

Everything this round created on the node was removed: targets `lp31` and `lp36` (and the
foreign `iqn.2000-05.com.example:lp35`), their LUNs and backstores, zvols `gtiscsi/lp31vol`
(already destroyed by LP1b), `gtiscsi/lp32round` and `gtiscsi/lp36vol`, the restored image
`/gtiscsi/images/lp31rest.raw`, datasets `gtbackup/lp35img` and `gtbackup/lp35b`, the restore
tree `/gtbackup/lp3new`, AHR pool `lp34` and its three 2 GiB spare disks (detached from the VM
and their images deleted), replication tasks `lp37ok` and `lp37nt` and remote `lpself`, and the
root SSH loop-back trust added for LP7. The iSCSI session opened for LP6 was logged out and its
node records deleted; `iscsid` was stopped.

Two cleanup steps are worth recording because they touched state the API deliberately guards:

- The LP5 control left the quarantined LUN's record in `saveconfig.json` (the correct
  behaviour — the record is what Repair replays). Since the control's dataset was being
  destroyed anyway, one manual `targetcli saveconfig` dropped it; health went clean
  (`degraded: false`) before the API deletes ran.
- Deleting an EMPTY, session-free target takes no confirmation, by design
  (`routes/iscsi-mutate.ts`: LUNs are refused `target-has-luns`, sessions `live-sessions`, and
  what is left is not data-destroying). The cleanup's first probe DELETE therefore removed the
  target outright and the confirmed retry reported `No such Target in configfs` — expected, not
  a defect.

Final state verified: `GET /v1/iscsi/health` `degraded: false`, `stubLuns: []`, `missingLuns: []`;
`GET /v1/ahr` `[]`; `/proc/mdstat` has no arrays; no `ANAS_HOT*` disks and no `anas-ahr` fstab
entries remain.

The PBS snapshots the round produced (`host/lp-files/2026-09-04T01:53:15Z`) were left in the
disposable datastore; they cost nothing and are part of the task's own history.
