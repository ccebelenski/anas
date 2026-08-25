# Live proof — 0.3.0 wave 1 (`iscsi.2`, `iscsi.3`, `backup2.2`)

Driven 2026-08-25 against the disposable stunt PVE 9 node `anas-pve` (192.168.200.50) at
`main` @ `baa0b5a`, deployed with `test/stunt-node/deploy-anas.sh`. Every call below went to
the REAL daemon on its unix socket (`/run/anas/anasd.sock`, identity headers
`x-anas-user` / `x-anas-user-uid` / `x-anas-request-id`, confirm retries via `x-anas-confirm`),
with a sample of the same calls repeated through the gateway
(`https://…:8006/anas/api/nodes/anas-pve/v1/…` with a PVE ticket) to prove the transport.
Answers were compared against the system's own truth — `targetcli ls`, configfs,
`saveconfig.json`, `zfs get -j`, `findmnt`, `find -xdev -printf '%D\t%p\n'`, the captured
`proxmox-backup-client` argv and `catalog dump` — never against fixtures.

## Verdicts

| Story | Verdict | Note |
|---|---|---|
| Deploy + version / skew | **PASS** | UI bundle, gateway and daemon all `0.2.12` → no skew banner |
| `iscsi.2` — read layer | **PASS**, with findings | every field matched configfs / `saveconfig.json`; restore hole + portal detector proven. **F1** (high) and **F2** (medium) below |
| `iscsi.3` — volumes | **PASS** | create sparse / grow / shrink-refused / property gating / snapshot / confirm-gated destroy all correct |
| `backup2.2` — nested filesystems | **PARTIAL** | everything the story specifies works; a run whose source holds a **dead** remote mount never finishes — **F3** |
| Untouched-edit contract | **PASS** | task `GET` → `PUT` back → unit **byte-identical** (absent and array `includeNested`) |

Suite after the one fix: `1990` daemon + `46` gateway tests, `125` + mounts + `90` UI
dialog-contract checks — all green; typecheck and lint clean.

---

## 1. Deploy and version

```
$ /root/aq.sh GET /v1/health
{"status":"ok","version":"0.2.12"}

$ grep -o "BUILD_VERSION *= *[^;]*" /usr/share/pve-manager/js/anas.js
BUILD_VERSION = '0.2.12'

$ curl -s -o /dev/null -D - http://127.0.0.1:3000/api/nodes/anas-pve/v1/health | grep -i x-anas-version
x-anas-version: 0.2.12
```

All three of the versions `ANAS.versionSkewBanner` compares agree, so the banner is absent
(`versionSkewBanner` returns `null` when nothing differs). **PASS.**

---

## 2. `iscsi.2` — the read layer

### 2.1 Steady state, every field against the system

The node's hand-built target (`iqn.2026-08.dev.anas.gtiscsi:target1`, tpg1, one portal, two
LUNs, two ACLs) read back exactly.

| Field | API | System truth |
|---|---|---|
| `ownership` / `ownershipReason` | `foreign` / `iqn-not-anas` | IQN's authority is `dev.anas.gtiscsi`, last label ≠ `anas` — expected for a hand-built target |
| portal | `192.168.200.50:3260`, `family inet`, `carriedByInterface true` | `configfs …/tpgt_1/np/192.168.200.50:3260`; `vmbr0` carries `192.168.200.50/24` |
| `security` | `authentication true`, `generateNodeAcls false`, `demoModeDiscovery true` | `attrib/authentication=1`, `generate_node_acls=0`, `demo_mode_discovery=1` (`targetcli ls`: `no-gen-acls, auth per-acl`) |
| LUN 0 serial | `9bc6e907-6015-4267-be4f-5a0617cb3d71` | `wwn/vpd_unit_serial` = `T10 VPD Unit Serial Number: 9bc6e907-…` — prefix stripped correctly |
| LUN 0 size | `2147483648` | `/sys/class/block/zd16/size` = `4194304` sectors × 512 |
| LUN 0 backing | `/dev/zvol/gtiscsi/vol1`, `kind zvol`, `pool gtiscsi`, `dataset gtiscsi/vol1` | `udev_path=/dev/zvol/gtiscsi/vol1` (never the `zd16` name — GT-48) |
| LUN 0 attrs | `emulateTpu true`, `emulateTpws true`, `blockSize 512`, `writeBack false`, `maxUnmapLbaCount 524288` | identical in `core/iblock_0/gtiscsi_vol1/attrib/` (`emulate_write_cache=0` → `writeBack false`) |
| LUN 1 | `kind file`, `plugin fileio`, `/gtiscsi/images/lun2.raw`, `1073741824`, serial `689844a4-…`, `maxUnmapLbaCount 262144` | identical in `core/fileio_1/gtiscsi_lun2/` and `ls -l` |
| ACL 1 | `chapUserid gtacluser`, `chapCredentialsSet true`, `mutualUserid gttargetuser`, `mutualCredentialsSet true`, `authenticateTarget true`, `mappedLuns [0,1]` | `acls/<iqn>/auth/{userid,userid_mutual,authenticate_target}`; **no secret appears anywhere in any response** |
| ACL 2 | all credential fields `null` / `false` | `auth/userid` and `auth/password` empty (`targetcli ls` prints `1-way auth` for it — that label is TPG-level and is correctly NOT surfaced) |

`installed: true`, `configfsPresent: true`, `saveconfigPresent: true` on all four endpoints —
the not-installed envelope is a state, not an error path, and with LIO present it is never
entered.

Status codes: `GET /v1/iscsi/targets` `200`; `GET /v1/iscsi/targets/not-an-iqn` **`400`**
(`VALIDATION_ERROR`, message names the three legal name forms); `GET
/v1/iscsi/targets/iqn.2026-08.dev.anas.gtiscsi%3Anosuch` **`404`**. The same URL-encoded IQN
resolved identically through the gateway, so the percent-encoding survives the proxy.

### 2.2 Sessions — login and logout, live

```
$ iscsiadm -m node -T iqn.2026-08.dev.anas.gtiscsi:target1 -p 192.168.200.50 --login
Login to [iface: default, target: …] successful.

$ cat …/acls/iqn.1993-08.org.debian:01:ae3d2ec18ad/info
InitiatorName: iqn.1993-08.org.debian:01:ae3d2ec18ad
InitiatorAlias: anas-pve
LIO Session ID: 1  ISID: …  TSIH: 1  SessionType: Normal
Session State: TARG_SESS_STATE_LOGGED_IN
CID: 0  Connection State: TARG_CONN_STATE_LOGGED_IN
   Address 192.168.200.50 TCP

$ /root/aq.sh GET /v1/iscsi/sessions
… "initiatorIqn":"iqn.1993-08.org.debian:01:ae3d2ec18ad","initiatorAlias":"anas-pve",
  "tpgTag":1,"sessionId":1,"state":"TARG_SESS_STATE_LOGGED_IN",
  "connections":[{"cid":0,"address":"192.168.200.50","state":"TARG_CONN_STATE_LOGGED_IN"}],
  "mappedLuns":[0,1]
```

Target summary `sessionCount` went `0 → 1`, and both LUNs' `connectedInitiators` carried the
initiator IQN. After `iscsiadm … -u`: `sessions: []`, `sessionCount 0`, `connectedInitiators
[]`. Read from `acls/<iqn>/info`, never `dynamic_sessions` (which stayed empty, as designed).

### 2.3 The restore hole (GT-20 / GT-21), live

```
$ systemctl stop rtslib-fb-targetctl && zpool export gtiscsi && systemctl start rtslib-fb-targetctl
$ systemctl is-active rtslib-fb-targetctl ; systemctl show … -p Result -p ExecMainStatus
active
Result=success
ExecMainStatus=0
$ targetcli ls /iscsi
  o- tpg1 … o- luns …………………………… [LUNs: 0]
```

systemd reported **success** with the target up and **zero LUNs** — reproduced exactly. The
API caught what systemd could not:

```
GET /v1/iscsi/health
"missingLuns":[
  {"targetIqn":"…:target1","tpgTag":1,"lunIndex":0,"backstoreName":"gtiscsi_vol1",
   "plugin":"block","backingPath":"/dev/zvol/gtiscsi/vol1","backingExists":false},
  {"…","lunIndex":1,"backstoreName":"gtiscsi_lun2","plugin":"fileio",
   "backingPath":"/gtiscsi/images/lun2.raw","backingExists":false}],
"degraded":true
```

Target summary showed `missingLunCount: 2`; the detail showed both LUNs `present:false`,
`backingExists:false`, **serials and attributes still carried** from `saveconfig.json`
(`9bc6e907-…` / `689844a4-…`, `emulateTpu`, `blockSize`, `maxUnmapLbaCount` intact) — which is
the replay material `iscsi.4`/`backup2.7` depend on.

`zpool import -d /var/tmp gtiscsi` + `systemctl restart rtslib-fb-targetctl` → health clean
again (`missingLuns []`, `degraded false`), both LUNs `present:true` with the same serials.
**`saveconfig.json` stayed byte-identical (sha256 `51a94be4…`) through the whole exercise** —
nothing in the read layer ever writes it, degraded or not.

### 2.4 Ownership = `anas`, and the two detectors that had no live coverage

A temporary ANAS-convention target was built by hand with the argv form of `targetcli` (which,
unlike stdin batching, does **not** auto-save — GT-5), so `saveconfig.json` was never touched:

```
$ targetcli "/backstores/fileio create lp_lun /gtbackup/lp-lun.raw 64M"
$ targetcli "/iscsi create iqn.2026-08.dev.anas:liveproof"
Created target iqn.2026-08.dev.anas:liveproof.
Created TPG 1.
Default portal not created, TPGs within a target cannot share ip:port.     ← GT-8 is conditional
$ targetcli "/iscsi/iqn.2026-08.dev.anas:liveproof/tpg1/luns create /backstores/fileio/lp_lun"
```

- **Ownership `anas`** (first live proof of the positive verdict):
  `"name":"liveproof","ownership":"anas","ownershipReason":"anas-managed"`,
  detail `IQN follows the ANAS naming convention and all 1 LUN are backed by ANAS-managed storage`.
- **`foreignChanges` / `target-not-persisted`**: `Target … is live but absent from the saved
  configuration — it will not come back after a reboot`.
- **Portal on an address no interface carries (GT-24)**: `targetcli "…/portals create
  10.99.99.1 3260"` → `Created network portal 10.99.99.1:3260.` with no complaint from LIO;
  the API reported `carriedByInterface:false`, `portalsWithoutInterfaceCount: 1` and a
  `portalsWithoutInterface` entry.
- **A missing backing FILE whose dataset is still mounted** (`mv /gtbackup/lp-lun.raw …`):
  `kind` stayed `file`, `pool gtbackup`, `backingExists:false`, ownership unchanged — broken is
  reported as broken, not as foreign. Correct.
- **Shipped fileio defaults, through the API** (a freshly created backstore, no ANAS
  attribute pass): `emulateTpu false`, `emulateTpws false`, `writeBack true`,
  `maxUnmapLbaCount 8192` — GT-26 and GT-30 confirmed at the read layer, and the reason
  `iscsi.4` must set them.

Everything was deleted afterwards (`targetcli "/iscsi delete …"`, both backstores, both image
files); `saveconfig.json` sha256 unchanged, health clean, one target left as before.

---

## 3. `iscsi.3` — ZFS volumes in Datasets

`GET /v1/pools/gtbackup/datasets` listed the pre-existing zvol with `type: "volume"`,
`mountpoint: null`, `volsize 536870912`, `volblocksize 16384`, `sparse false`
(`refreservation` is `local` on it) and `defaults: {"volblocksize": 16384}` — which equals
`zfs get -s default volblocksize` (`16K`, source `default`) on ZFS `2.4.3-pve1`. The parser
only accepts a value whose `source.type` is `DEFAULT`, so a pool of explicitly-blocked volumes
cannot mislead it.

**Create (sparse, explicit 8K):**

```
POST /v1/pools/gtbackup/datasets {"path":"vol2","type":"volume","volsize":1073741824,
                                  "volblocksize":8192,"sparse":true}     → 202
$ zfs get -j volsize,volblocksize,refreservation gtbackup/vol2
volsize        1G     LOCAL
volblocksize   8K     NONE      (create-time)
refreservation none   DEFAULT   ← sparse
```

**Grow → 2 GiB:** `PUT {"properties":{"volsize":2147483648}}` → `202`; `zfs get -Hp` →
`volsize 2147483648 local`, `refreservation 0 default` (still sparse). The API read back
`volsize 2147483648, sparse true`.

**Shrink refused, no bypass:**

```
PUT {"properties":{"volsize":1073741824}}  → 409 Conflict
{"code":"CONFLICT","reason":"shrink","message":"Volume 'gtbackup/vol2' is 2147483648 bytes;
 a volsize of 1073741824 bytes would SHRINK it. ZFS would truncate it silently and anything
 written past the new end — a partition table, a filesystem, a LUN's data — would be gone.
 Destroy and recreate the volume at the smaller size instead. This refusal has no confirm bypass."}
```

Response headers carried **no `X-Anas-Confirm-Code`** (Level-1 refusal), and `zfs get` after
the refusal still read `volsize 2147483648` — untouched. A no-op `PUT` of the *current*
volsize is accepted and changes nothing (`volsize`, `volblocksize`, `refreservation` all
identical afterwards).

**Property gating, both directions:** `recordsize` / `quota` / `atime` on a volume →
`400 VALIDATION_ERROR` (`'gtbackup/vol2' is a volume; recordsize is a filesystem property and
ZFS does not carry it on a volume`); `volsize` on a filesystem → `400` (`'gtbackup/cdm' is a
filesystem; volsize applies only to a volume`).

**No path to share:** the volume detail carries `mountpoint: null`, `permissions: null`,
`associatedShares: []` — the three facts the UI's "Share this" / Permissions gating reads
(the dialog-contract harness already asserts those buttons are disabled on a volume row).

**Snapshot → destroy snapshot → confirm-gated destroy volume:**

```
POST …/vol2/snapshots {"name":"lp1"}  → 202 ;  zfs list -t snapshot → gtbackup/vol2@lp1
GET  …/vol2/snapshots                 → {"name":"gtbackup/vol2@lp1","snapshotName":"lp1",…}
DELETE …/vol2/snapshots/lp1           → 202, no confirm code (snapshot destroy is Level 0)
DELETE …/vol2                         → 409 CONFIRMATION_REQUIRED
                                        x-anas-confirm-code: 04adf6682143
                                        x-anas-confirm-expires: …
DELETE …/vol2  (x-anas-confirm: …)    → 202 ;  zfs list -r gtbackup → vol2 gone
```

`GET /v1/status` stayed `200` with volumes present (pools `gtbackup`, `gtiscsi`, the same six
pre-existing warnings, none of them about a volume).

**Left behind as requested:** `gtbackup/sparse1` — 512 MiB, `volblocksize 16384` (ZFS default,
source `default`), `refreservation 0 default` (sparse).

---

## 4. `backup2.2` — nested filesystems

> **Reality check.** The brief expected `/gtbackup` to have `data`, `cdm` and `images` as child
> datasets. On the node only `gtbackup/cdm` is a dataset; `data` and `images` are plain
> directories inside the pool root dataset, and `gtbackup/vol1` is a zvol. A second dataset
> `gtbackup/lp` (one marker file) was created for the duration so `all` and `[paths]` could be
> told apart, then destroyed. The detector's answers below are against that real shape.

### 4.1 Detection — an `st_dev` walk, not a mount enumeration

```
$ find -P /gtbackup -xdev -maxdepth 3 -type d -printf '%D\t%p\n'
46  /gtbackup            46  /gtbackup/images     49  /gtbackup/cdm
46  /gtbackup/data       46  /gtbackup/data/…

POST /v1/backup/tasks/preview-nested {"path":"/gtbackup"}
  nested: [{"path":"/gtbackup/cdm","relativePath":"cdm","kind":"dataset",
            "source":"gtbackup/cdm","fstype":"zfs","included":false}]
```

The zvols (`gtbackup/vol1`, `gtbackup/sparse1`) correctly do **not** appear — they are not
filesystems. `truncated:false`, no warnings.

**`/etc` → `/etc/pve` as `pmxcfs`** (the story's product-level example):

```
POST … {"path":"/etc"}
  {"path":"/etc/pve","relativePath":"pve","kind":"pmxcfs","source":"/dev/fuse",
   "fstype":"fuse","included":false}
```

**Coverage flags against the three choices** (one preview, three archives, same source):

| `includeNested` | `cdm` | `lp` |
|---|---|---|
| absent → `none` | `included:false` | `included:false` |
| `all` | `true` | `true` |
| `["/gtbackup/cdm"]` | `true` | `false` |

**Depth budget:** a 15-deep directory chain under a source reported `truncated: true` with
`nested: []` — a floor, never an implied "none". A non-existent path returned `exists:false`
with the walk's own message as a warning, `200`.

### 4.2 Absent means absent — the unit JSON

Task created with ONE archive `/gtbackup` and no `includeNested`:

```
# X-ANAS-Task={"name":"lp-nested","repository":"lp-repo","namespace":"gtrestore",
#   "backupId":"liveproof-nested","archives":[{"name":"gtbackup","path":"/gtbackup",
#   "excludes":[]}],"changeDetectionMode":"default","notify":"on-failure",
#   "schedule":"Mon *-*-* 03:00:00","enabled":true,"limitNofile":1024}
```

**No `includeNested` key.** The task detail's `nested[]` listed both children with
`included:false`.

### 4.3 The three runs — argv, warnings, and the catalog

argv was captured from `/proc/*/cmdline` while each run was in flight.

| Run | `includeNested` | captured `proxmox-backup-client` argv (tail) | job result |
|---|---|---|---|
| 1 | absent | `backup gtbackup.pxar:/gtbackup --backup-id liveproof-nested --ns gtrestore` | `success` + 2 warnings |
| 2 | `all` | `… --include-dev /gtbackup/cdm --include-dev /gtbackup/lp` | `success`, no warnings |
| 3 | `["/gtbackup/cdm"]` | `… --include-dev /gtbackup/cdm` | `success` + 1 warning |

**`--all-file-systems` never appeared** (`grep -c` over both argv captures: `0`) — `all` is
resolved at run time into per-archive `--include-dev`, exactly as ruled.

Run 1's warnings:

```
archive 'gtbackup': nested filesystem /gtbackup/cdm (dataset) is NOT included - it is backed up as an empty directory
archive 'gtbackup': nested filesystem /gtbackup/lp (dataset) is NOT included - it is backed up as an empty directory
```

Run 3's warnings named only `/gtbackup/lp`. The unit journal's result JSON carried the full
`nested[]` with `included` flags plus `includedNested` per archive.

**`catalog dump` of the resulting snapshots — the omission is real and the inclusion is real:**

| snapshot | total catalog lines | entries under `cdm/` | under `lp/` |
|---|---|---|---|
| run 1 (`none`) | 24 | **0** (`d "./gtbackup.pxar.didx/cdm"` — an empty directory) | **0** |
| run 2 (`all`) | 2030 | **2005** | `f "./gtbackup.pxar.didx/lp/lpmarker.txt" 40` |
| run 3 (`[cdm]`) | 2029 | **2005** | **0** |

### 4.4 The dead-mount path

An NFSv4 export was served by the node to itself over a dummy interface, mounted at
`/gtbackup/data/remote`, then black-holed by deleting the address (`timeout 5 ls` on it → exit
124, i.e. genuinely wedged).

**The detector is hang-proof.** Both while the mount was live and after it was black-holed:

```
POST /v1/backup/tasks/preview-nested {"path":"/gtbackup/data"}   real 0m0.017s
  {"path":"/gtbackup/data/remote","relativePath":"remote","kind":"nfs",
   "source":"10.99.99.1:/var/tmp/lp-nfs-src","fstype":"nfs4",
   "detail":"remote mount — recorded from the mount table, never probed (the hang trap)",
   "included":false}
```

17 ms against a dead server: recorded from `findmnt`, pruned from the walk, never stat'ed.
`GET /v1/backup/tasks/lp-dead` (which runs the same scan) answered in 0.47 s, and the daemon
stayed fully responsive throughout (`/v1/status` 200 in ~2 s — the mounts family's own
`timeout 2 stat -f` ceiling; `/v1/iscsi/targets` 200 in 77 ms).

**The RUN, however, does not finish — see finding F3.**

### 4.5 Untouched-edit contract, live

```
BODY=$(GET /v1/backup/tasks/lp-nested | .data.task)      # the daemon's own detail, verbatim
PUT /v1/backup/tasks/lp-nested "$BODY"                   → 202
diff <unit before> <unit after>                          → UNIT BYTE-IDENTICAL
                                                            TIMER BYTE-IDENTICAL
```

Proven twice: with `includeNested` **absent** (nothing is written where nothing was) and with
`includeNested: ["/gtbackup/cdm"]` present (the array survives verbatim). The echoed-back
`datastore` field the detail adds is tolerated and dropped rather than persisted. Saving an
`includeNested` path outside the archive source is a `400`
(`nested filesystem '/etc' is not under the archive path '/gtbackup'`).

On the ZFS side a no-op `PUT` of a volume's current `volsize` leaves `volsize`,
`volblocksize` and `refreservation` untouched.

---

## Findings

### F1 — HIGH (`iscsi.2` schema, bites `iscsi.4`): the documented domainless ANAS IQN is rejected by LIO

`anasIqn()` and `DESIGN.md` both specify `iqn.<yyyy-mm>.anas:<name>` for a node with no DNS
domain. rtslib-fb 2.1.76 validates an `iqn.` name with

```python
'iqn': lambda wwn: re.match(r"iqn\.[0-9]{4}-[0-1][0-9]\..*\..*", wwn) \
                   and not re.search(' ', wwn) and not re.search('_', wwn),
```

— it demands at least one *further* dot after the date field. Live:

```
$ targetcli "/iscsi create iqn.2026-08.anas:liveproof"
WWN not valid as: iqn                       (exit 1)
$ targetcli "/iscsi create iqn.2026-08.dev.anas:liveproof"
Created target iqn.2026-08.dev.anas:liveproof.
```

So `iscsi.4`'s create would fail outright on a domainless node, and `IscsiIqn` currently
accepts a name LIO will refuse. (The stunt node has domain `local`, so its generated form
`iqn.<yyyy-mm>.local.anas:<name>` happens to pass — the failure only shows on a node with no
domain at all.) rtslib also refuses `_` and space anywhere in the name; `IscsiTargetName`
already excludes both, so only the label count is a problem.

**Not fixed** — the remedy changes the documented naming convention (e.g. a two-label
domainless authority such as `<node>.anas`, plus an `IscsiIqn` refinement requiring ≥2
authority labels so ANAS refuses before LIO does). That is a design call.

### F2 — MEDIUM (`iscsi.2`): a file-backed LUN whose pool is not imported reads as `foreign`, and takes its target's ownership with it

With `gtiscsi` exported (the GT-20/21 restore hole of §2.3), the two LUNs diverged:

| LUN | backing | `kind` while the pool was gone | `pool` / `dataset` |
|---|---|---|---|
| 0 | `/dev/zvol/gtiscsi/vol1` | `zvol` (correct) | `gtiscsi` / `gtiscsi/vol1` |
| 1 | `/gtiscsi/images/lun2.raw` | **`foreign`** | absent |

`classifyBacking` parses a zvol out of its stable path but resolves a *file* through
`readZfsMountpoints()`, which is empty for a pool that is not imported. `deriveOwnership` then
turns any `kind: 'foreign'` LUN into `ownership: foreign, reason: backing-not-anas-storage` —
proven live by mapping a LUN backed by `/var/tmp/lp-off.raw` into the ANAS-IQN target:

```
before: "ownership":"anas","ownershipReason":"anas-managed"
after : "ownership":"foreign","ownershipReason":"backing-not-anas-storage",
        "ownershipDetail":"LUN 'lp_off' is backed by /var/tmp/lp-off.raw, which is not on storage ANAS manages"
```

Composed, that means an ANAS-owned target whose file-backed LUN sits on a pool that failed to
import at boot reads as **hands-off, foreign** — precisely in the state `iscsi.5` exists to
make actionable. It also contradicts the module's own stated intent ("A LUN whose backing path
does NOT resolve is a third thing, and it is deliberately not 'foreign' … a target whose LUNs
are on ANAS storage stays ANAS's problem to fix"), which today holds only for zvols. Note the
narrower case is already right: a file that is *missing* while its dataset is mounted stays
`kind: file` with `backingExists:false` and does not move ownership.

**Not fixed** — an honest fix needs a third classification/ownership tier
(`backing-unresolvable`, or feeding `backingExists` into the derivation), i.e. a schema change.

### F3 — MEDIUM (`backup2.2`): a run whose source contains a DEAD remote mount never finishes

ANAS's own detection is hang-proof (§4.4). The RUN is not, because it hands
`proxmox-backup-client` the source path and pbc must cross the boundary itself:

```
$ ps -eo pid,stat,wchan:30,args
187583 Sl  futex_do_wait  /usr/bin/proxmox-backup-client backup data.pxar:/gtbackup/data \
                              --backup-id liveproof-dead --ns gtrestore
$ systemctl show anas-backup-lp-dead.service -p ActiveState -p SubState
ActiveState=activating   SubState=start
```

The job stayed `running` for the whole observation (120 s of polling) and would only end at
`superviseRun`'s 600 s ceiling — which reports `status: running` truthfully, not a failure —
while the pbc process and its unit stay active indefinitely. Nothing but `systemctl stop`
plus `SIGKILL` cleared it. The daemon itself was never affected (`/v1/status` and
`/v1/iscsi/targets` both `200` throughout), so this is a wedged RUN, not a wedged ANAS.

Candidate remedy (**not implemented** — it changes the emitted argv, i.e. a design call): when
an uncovered nested filesystem is a **remote** mount, emit `--exclude <relativePath>` for it so
pbc never stats the boundary; and/or refuse at save time, which is what the standing
"backup source guard" candidate note already contemplates.

### F4 — LOW (`backup2.2`) — **FIXED**: `includedNested` was dropped by the supervised Run-Now path

`runBackup` emits `includedNested` (it reaches the unit journal and the 16.12 notification),
but `classifyTerminalRun` copied only `archives` / `target` / `nofileWarning` / `prune` /
`warnings` / `reason` out of the helper JSON. So `POST /v1/backup/tasks/:name/run` reported
what was **omitted** and never what was **crossed** — half of the never-silent contract.

Fix: forward the field, exactly as `prune` is forwarded.
`packages/daemon/src/services/backup-units.ts` — `includedNested?: Record<string, string[]>`
added to `HelperResult` and `SuperviseRunResult`, plus

```ts
if (helper?.includedNested && Object.keys(helper.includedNested).length)
  result.includedNested = helper.includedNested
```

Regression test: `packages/daemon/src/services/__tests__/backup-units.test.ts` —
*"includedNested survives the supervised Run-Now (backup2.2, live-proof wave 1)"*, which also
asserts an absent field stays **absent** (never `{}`). Re-deployed and re-proven live:

```
POST /v1/backup/tasks/lp-fix/run  → job.result
  "includedNested": {"gtbackup": ["/gtbackup/cdm"]}
```

No UI change: `68-backup.js` reads `result.warnings` and `result.prune` only.

---

## Observations (not findings)

- **O1** `POST /v1/backup/tasks/preview-nested` accepts `includeNested` paths *outside* the
  previewed path (`200`), while saving the same shape on a task is a `400`. Preview is
  advisory, so this is not wrong — but the two boundaries disagree.
- **O2** A never-run backup task reports `lastRunResult: "success"` with `lastRunAt: null`
  (systemd's `Result=success` on a unit that has never started). Pre-existing Epic 16
  behaviour; `buildBackupWarnings` treats `success` as benign, so nothing warns.
- **O3** A volume's `properties` block reports `recordsize: 0`, `atime: false`, `quota: 0` —
  properties ZFS does not carry on a zvol (the `properties.all` block correctly omits them,
  and a `PUT` of any of them is a `400`). Cosmetic; the UI disables Edit Properties on a
  volume row anyway.
- **O4** A `PUT` of a property whose current source is `default` flips it to `local`
  (`compression=on` on `gtbackup/cdm` did). Pre-existing and unavoidable at the API — the
  dialog contract (never send an untouched field) is what protects it. Restored to inherited.
- **O5** (tooling only) `proxmox-backup-client catalog dump` writes its listing to **stderr**
  and rejects an archive argument. Affects verification commands, not ANAS — the design uses
  `catalog shell`.
- **O6** `targetcli` reported `Default portal not created, TPGs within a target cannot share
  ip:port.` when creating a second target on a node whose `0.0.0.0:3260` slot was taken —
  GT-8's "conditional" caveat, confirmed. `iscsi.4` must verify rather than assume.

---

## Node state left behind

- **New:** ZFS volume `gtbackup/sparse1` — 512 MiB, sparse, ZFS-default `volblocksize` (16K).
- **New:** PBS snapshots in namespace `gtrestore`, group `host/liveproof-nested` (four, from
  the runs above) — harmless, kept deliberately.
- **Removed again:** backup tasks `lp-nested`, `lp-dead`, `lp-fix` (units and timers gone);
  dataset `gtbackup/lp`; ZFS volume `gtbackup/vol2`; the temporary NFS export, its dummy
  interface and the `/gtbackup/data/remote` mountpoint (`/etc/exports` restored verbatim); the
  temporary LIO target `iqn.2026-08.dev.anas:liveproof` and its two fileio backstores.
- **Unchanged:** `/etc/rtslib-fb-target/saveconfig.json` (sha256 `51a94be4…` before, during
  and after), the ground-truth target `iqn.2026-08.dev.anas.gtiscsi:target1` with both LUNs,
  both serials and both ACLs, pools `gtiscsi` and `gtbackup`, and the registered repo
  `lp-repo`. `GET /v1/iscsi/health` ends clean and non-degraded.
