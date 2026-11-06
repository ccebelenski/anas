# Live proof — scrub.r1 and scrub.r2: the AHR scrub survives its deadline, and the Scrubs row tells the truth (GitHub #81, #82)

Driven 2026-11-06 against the disposable stunt PVE 9 node `anas-pve` (192.168.200.50),
kernel `7.0.14-20-pve`, btrfs-progs `6.14`. Every output below is verbatim from the node or
from the job records read over the daemon socket; timestamps are the node's unless marked
host-local (EST).

## Why a rig, and what it is

Both defects were found on a production fleet node whose first periodic AHR scrub of 0.4.4
(2026-11-01) failed on both pools: phase 1 ran a day and a half per pool, phase 2 died at
exactly 300 s. The stunt node never reproduced it because its loop-device pools scrub in
seconds — a 4 GiB pool finished its checksum pass in **2 s at 2.00 GiB/s** on the first
attempt here, served from the hypervisor's cache. The rig therefore throttles the VM's disks at
the hypervisor, which the guest cannot see and the cache cannot defeat:

```
# host, three 3 GiB qcow2 disks attached as ANAS_HOT21..23 (VM targets sdw/sdx/sdy)
sudo virsh blkdeviotune anas-pve <target> --read-bytes-sec 3000000 --live
```

- Pool: `sr1`, `ahr1`, three disks → one raid5 band `sr1-r1` (`md127`, 6.28 GB), LVM, btrfs
  at `/mnt/anas-ahr/sr1`, 6.0 G.
- Data: 4 × 1 GiB from `/dev/urandom` (`btrfs fi usage`: Used 4.01 GiB).
- At 3 MB/s per disk the md check of phase 1 takes ~20 min and the btrfs pass of phase 2
  ~9 min — comfortably over the 300 s job-lane budget that cr.34 put on every command.

Created through the daemon (`POST /v1/ahr`, 409 confirm, replay with `x-anas-confirm`,
job completed in 30 s). The throttle is applied before the scrub is submitted and cleared
after the job ends; the driver script polls the job every 5 s.

## 1. The defect, reproduced on the pre-fix build (0.4.4 code: `btrfs scrub start` without `-B`)

Job `66de6a79-b4ff-406c-96ca-ff59010fe6a2`, submitted 06:28:12 UTC.

```
01:28:18 running | md check on sr1-r1 (0.4%)
…
01:48:27 running | phase 2/2: btrfs checksum scrub
01:53:23 failed  | phase 2/2: btrfs checksum scrub
```

Final record (fields that matter):

```
"status": "failed",
"error": {
  "code": "TIMEOUT",
  "message": "'btrfs scrub' did not finish within 300 s and was stopped (a suspended pool, a hung disk or mount, or an unresponsive remote host is the usual cause); what it was acting on is in an unknown state — check it before retrying"
},
"result": null
```

Phase-2 wall clock from the first `phase 2/2` poll to the failure: **296 s**. On the node:

```
$ btrfs scrub status /mnt/anas-ahr/sr1
Status:           interrupted
Total to scrub:   4.01GiB
$ journalctl -k
06:48:22 kernel: BTRFS info (device dm-0): scrub: started on devid 1
06:53:22 kernel: BTRFS info (device dm-0): scrub: not finished on devid 1 with status: -4
```

Byte for byte the fleet node's failure (same TIMEOUT sentence, same `status: -4`, same
`interrupted`). The 300 s is the job lane's budget: `btrfs scrub start` forks a scrub child
that keeps the daemon's pipes and process group, the executor waits on the pipes, the deadline
signals the group, the signal interrupts the scrub.

## 2. The fix, on the same rig (main at 03375c011, scrub.r1: `btrfs scrub start -B`, no deadline, status polled beside it)

Deployed with `./test/stunt-node/deploy-anas.sh`; `dist/services/ahr-scrub.js` carries
`'scrub', 'start', '-B'`. Same throttle, same pool, same data. Job
`3a437c16-500b-4328-9db3-47ea411119bd`, submitted 06:54:15 UTC.

```
01:54:20 running | md check on sr1-r1 (0.4%)
…
02:14:19 running | btrfs scrub running (0.0%)
…                                                (103 progress polls, every 5 s)
02:23:11 completed | btrfs scrub running (99.2%)
```

Final record:

```
"status": "completed",
"startedAt": "2026-11-06T06:54:15.510Z",
"completedAt": "2026-11-06T07:23:11.316Z",
"error": null,
"result": { "scrubbed": "sr1", "btrfsErrors": null, "checkedArrays": 1, "bandsChecked": ["sr1-r1"] }
```

On the node:

```
$ btrfs scrub status /mnt/anas-ahr/sr1
Status:           finished
Total to scrub:   4.01GiB
$ journalctl -k
07:14:15 kernel: BTRFS info (device dm-0): scrub: started on devid 1
07:23:10 kernel: BTRFS info (device dm-0): scrub: finished on devid 1 with status: 0
```

Phase 2 ran **532 s** — 1.8× the budget that killed it before — and the job completed with the
pass's own verdict. Progress was reported throughout from the status poll beside the
blocking command.

| | pre-fix | fixed |
|---|---|---|
| phase 2 wall | 296 s → TIMEOUT | 532 s → completed |
| kernel | `not finished … status: -4` | `finished … status: 0` |
| `btrfs scrub status` | interrupted | finished |
| job | failed, result null | completed, clean result |

## 3. scrub.r2 on the node (main at fb2d58762, both stories deployed)

Same pool, same throttle. The daemon's answers were read over its socket; the row rendering
itself is pinned by the dialog-contracts harness (2428 checks), since no browser drives the
stunt node.

### 3a. A btrfs scrub started outside ANAS shows as running

```
$ btrfs scrub start /mnt/anas-ahr/sr1        # by hand, detached
$ btrfs scrub status /mnt/anas-ahr/sr1
Status:           running
Bytes scrubbed:   40.62MiB  (0.99%)
GET /v1/scrub  (sr1)  →  {"running": {"phase": "btrfs-checksums", "percent": 1.95}, "lastScrub": null}
$ btrfs scrub cancel /mnt/anas-ahr/sr1
Status:           aborted
GET /v1/scrub  (sr1)  →  {"running": null, "lastScrub": null}
```

Before the story that row read idle throughout.

### 3b. An ANAS scrub names its pool while running and reports each phase

Job `92e94f22-9fd1-4694-b32e-929d333e4294`, submitted 07:46:38 UTC.

```
02:46:43 running | md check on sr1-r1 (0.5%)
GET /v1/scrub  (sr1)  →  {"running": {"percent": 1.3, "speedBytesSec": 2908160, "etaSeconds": 1086, "phase": "md-parity"}}
GET /v1/jobs/<id>     →  "detail": {"pool": "sr1"}            (while running, before phase 1 ended)
…
GET /v1/scrub  (sr1)  →  {"running": {"phase": "btrfs-checksums", "percent": 4.72}}   (phase 2)
```

### 3c. A scrub that fails is a failed job with its pool, a notification, and no stale running state

With phase 2 at 4.8 %, the btrfs scrub was cancelled by hand (`btrfs scrub cancel`), which is
the failure both stories agree on: the blocking `-B` command returns and the final status read
says `aborted`.

```
03:06:53 cancelling the btrfs scrub by hand
03:06:59 failed | btrfs scrub running (4.8%)

final job record:
 "status": "failed",
 "completedAt": "2026-11-06T08:06:58.500Z",
 "detail": { "pool": "sr1" },
 "error": { "code": "JOB_FAILED", "message": "btrfs scrub on 'sr1' was aborted" },
 "result": null

GET /v1/jobs?status=failed  →  the same entry, operation ahr.scrub, detail {"pool": "sr1"}
GET /v1/scrub  (sr1)        →  {"running": null, "lastScrub": null}

$ journalctl
08:06:58 perl[65221]: notified via target `mail-to-root`
08:06:58 proxmox-mail-forward[65227]: notified via target `mail-to-root`
$ journalctl -u anasd
{"event":"job.failed","operation":"ahr.scrub","params":{"name":"sr1"},"durationMs":1220302,"error":"btrfs scrub on 'sr1' was aborted"}
```

The failed entry carries everything the Scrubs row needs (`detail.pool`, `error.message`,
`completedAt`); the harness pins that it renders as `last scrub failed · <date>` in amber with
the message as tooltip, that a later completed scrub displaces it, and that a parity reading
from the previous completed pass stays on the row beside it. The notification is the one
`AHR scrub failed` warning; the per-band rot warning is the only other notice a scrub sends.

## 4. The finding path through the new phase 2: one rotted block beneath md, found, attributed, repaired (main at 77a0cfc98, 2026-11-06 10:43–10:45 EST)

scrub.r1 changed how phase 2's verdict is read (a non-zero exit of the blocking `scrub start -B`
is a finding, not a failure), and the production node's hand-run checksum pass had meanwhile
found exactly that: one uncorrectable csum error in a plot file, 4 KiB, with the band's
`mismatch_cnt` still at 8 sectors from the earlier parity check — one member rotted beneath md.
The rig reproduced that shape on the same pool, with no throttle (operator: "you can actually test
the corruption on the stunt node by manipulating the bytes on the backing virtual disk files").

**Injection.** `fill2.bin`'s 4 KiB block at file offset 512 MiB (block 131072) was read through
btrfs and located on the members by a byte scan: `/dev/sdd1` at byte 1274019840, 4 KiB aligned
(not on sdb1/sdc1). Its sha256 and the file's were kept. 4 KiB of urandom were written ON THE
MEMBER at that offset (`dd … oflag=direct`, `drop_caches`), bypassing md: parity now disagrees
with the data on that stripe, and btrfs's stored csum disagrees with what md returns.

```
$ POST /v1/ahr/sr1/scrub {}                                   job 78787b03
10:43:45 running | md check on sr1-r1 (0.1%) … (95.5%)
10:44:11 running | btrfs scrub running (status unreadable: WARNING: failed to open status file: Resource temporarily unavailable)
10:44:15 completed | Attributing scrub errors: 1/1 (/mnt/anas-ahr/sr1/fill2.bin)
result: btrfsErrors "csum=1", parityMismatches [{band sr1-r1, mismatchCnt 8, raid5}],
        findings [{path /mnt/anas-ahr/sr1/fill2.bin, subvolume @data, inode 258,
                   stripes [{logical 2261778432, offset 536870912, length 4096}], badBlocks [131072]}],
        errorsReported 1, errorsAttributed 1, unattributed 0

$ POST /v1/ahr/sr1/repair {"files":[{"path":"/mnt/anas-ahr/sr1/fill2.bin","blocks":[131072]}]}
409 CONFIRMATION_REQUIRED, x-anas-confirm-code (six warnings: the snapshot, the md knobs, the one
   4 KiB write through md after the reconstruction matches the stored csum, the cost, nothing
   else touched, an unprovable block left alone)
replay with x-anas-confirm                                    job 6fee09be, 202
10:44:16 running | Repairing /mnt/anas-ahr/sr1/fill2.bin block 131072 (1/1)
10:44:33 completed | block 131072: repaired — "reconstructed from the XOR of the other 2 members of
         stripe 2422 and verified against the stored csum 0xb92c3c27"
result: repaired 1, unrepairable 0, aboveMd 0, mappingAbort 0, parityResiduals []

verify (drop_caches first):
  sha256 fill2.bin  85d5b07f…6f25  == the hash taken before the injection
  /dev/sdd1 @ 1274019840 read O_DIRECT == the original block (cmp)
  /sys/block/md127/md/mismatch_cnt = 0 (the repair's bounded postcheck)
$ POST /v1/ahr/sr1/scrub {}                                   job 2, 10:44:40 → 10:45:10
result: btrfsErrors null, bandsChecked [sr1-r1], no parityMismatches, no findings
btrfs scrub status: finished, no errors found; mismatch_cnt 0
notifications: three `notified via target mail-to-root` lines — the band's parity warning and
  "AHR scrub found errors" from the first scrub, the repair's info notice; audit job.completed
  for ahr.scrub and ahr.repair.
```

The whole R2 tree of `AHR-SELF-HEAL-DECISION-TREE.md` ran on the fixed phase 2: the scrub's
non-zero exit became the finding, the kernel line was attributed to the file and block, the
band's mismatch rode the same result, the Repair door reconstructed the block from parity and
proved it against the stored csum before the one write, and the next scrub was clean. This is
the shape the production node will present on its first ANAS scrub of the release.

One cosmetic residual, seen once in three polls: while the blocking `scrub start -B` holds the
status file's lock, a progress poll reads `WARNING: failed to open status file: Resource
temporarily unavailable` and the progress text shows that sentence until the next poll. Progress
only (r1 fold) — the verdict is the final read, retried. A rider: keep the last good percentage
on a transient read failure instead of showing the warning text.

## Residuals

- The fleet proof — the production node completing a full ANAS scrub of both pools — moves to
  AFTER the release (operator 2026-11-06, away for the week: "those scrubs will complete while
  I'm gone — we can pick up on them next week"; the pre-release stand-in is §4, the same shape
  the node will present). Its hand-run checksum passes (the #81 workaround) finish first (one has
  already found a single uncorrectable 4 KiB csum error in a plot file, beside a band's 8-sector
  mismatch from 2026-11-02 — almost certainly the same block), then the node upgrades to the
  released build and its first ANAS scrub attributes and repairs it through the product.
- Progress text during phase 2 can show the status file's transient lock warning for one poll
  (§4); cosmetic, a rider.
- The 300 s budget is the job lane's default; nothing else in the daemon forks a child that
  keeps the caller's pipes (sweep of every executor call site, scrub.r1 report).
- An `ahr.scrub` job has no cancel hook; the Scrubs screen's Stop posts the ZFS action only.
  Unchanged by both stories.
