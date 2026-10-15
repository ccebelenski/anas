# Live proof — 0.4.4 wave 3b (nf.1, nf.2, cr.33b, cr.35r re-proofs; cr.25b leftovers), stunt node

Node: the stunt node (PVE 9 / pve-manager 9.2.21, kernel 7.0.14-23-pve, zfs-2.4.4-pve1, Node v22.23.3), the same node
and build method as [wave 3](LIVE-PROOF-0.4.4-wave3.md), 2026-10-15 UTC, 16:49–17:16.
Build: worktree fast-forwarded `026bf64..5b36fbe` (main HEAD at the start; contains nf.1 `007bb4a`, cr.35r `dfff95b`,
cr.33b `c95b21c`, nf.2 `3cf3236` + `5b36fbe`). Main moved during the pass by two EPICS-only commits (`f4ada88`,
`45713da`, no code), so there was no redeploy.
ADOCK is installed on the same node; none of its pieces were edited, stopped or redeployed: CT 9900 `ingress-default`
`stopped`, `protection: 1`, `onboot: 0`, the same tags and description before and after; `/anas/` and `/adock/` answered
401 before and after. `ls /anas /adock` → No such file or directory, both times (the two are URL paths, not
directories). The PBS VM was not touched (the ident-iscsi test that backs up to it was deliberately not run).

Methods as in wave 3: API calls through the gateway exactly as the panels go (`https://<node>:8006/anas/api/nodes/
anas-pve/v1/...`, root@pam ticket + CSRF token), with wave 3's client (`docs/probes/wave3-node/api.sh`, `lib.sh`); 202 jobs
polled through `GET /v1/jobs/:id`; a 409 confirm resent with `x-anas-confirm: <code>`. Every probe is a script under
`docs/probes/wave3b-node/` and its raw output is under `docs/probes/wave3b-node/out/` (`run.sh <script> <log>` runs one).

Throwaway objects carry a `w3r` prefix: pools `w3r2`, `w3r4`, `w3r5s`, `w3r5d` (dm device `w3r5d`), mount `/mnt/w3r3`,
runtime NFS export `127.0.0.1:/srv/w3r-nfs`, nft table `inet w3r2`, task `w3r5rep`, cloud remote `w3rbad`, images under
`/var/tmp/w3r/`, hot disks 20–23 (created for the pass, detached, images deleted). Two exceptions, both forced by the
brief or the spec: row 1 uses `vdev-fixture.sh up-byid`, whose pool is `gtvdev` on hot disk 9 (the brief names the
fixture), and the row-7 specs create their own named objects (`anasactcreate`, `identproof-*`, `ident4-*`, the cloud
fixture's `gtbackup/cloudsrc`), each removed by the spec or its fixture.

Classification key (brief rule): (a) stale test expectation, (b) test/script bug, (c) node fact. A product defect is
recorded as **D<n>** (numbering continues wave 3's D1–D9) with a repro, a severity and the suspected file:line; none
fixed.

---

## R0 — deploy

```
host$ git merge-base HEAD main -> 026bf64 (= HEAD);  git merge --ff-only main  026bf64..5b36fbe
host$ npm ci; ./test/stunt-node/deploy-anas.sh               (out/deploy.log)
  ✓ anasd active, 0 restarts, /v1/health answers version 0.4.3
  ✓ anas active, /installed answers the same version
host vs node, sha256 of every file under packages/{daemon,gateway,shared}/dist (2136 files, LC_ALL=C sorted list):
  identical; hash of the list 2298f87e3d8a6b90                  (out/dist-hashes.txt, ten named files spot-listed)
node# curl --unix-socket /run/anas/anasd.sock …/v1/health -> {"status":"ok","version":"0.4.3","abandonedCommands":[]}
```

**Verdict: PROVEN** — `5b36fbe` deployed and running (anasd pid 710378, NRestarts 0 at the end).

---

## Row 1 — nf.1 D1: a partition replaces a partition

`r1-partition-replace.sh`, `r1b-partition-attach.sh`; pool `gtvdev` from `vdev-fixture.sh up-byid` (six classes on six
by-id partitions of hot disk 9, kernel `sdd`).

```
blkid -p …HOT9-part1 (live data leaf) -> exit 0
  VERSION="5000" LABEL="gtvdev" UUID="530292408976651879" UUID_SUB="…" … TYPE="zfs_member" USAGE="filesystem" PART_ENTRY_SCHEME="gpt" …
zpool remove gtvdev …-part4 (the AVAIL spare) -> exit 0
blkid -p …-part4 -> exit 0:  VERSION="5000" UUID_SUB="13671146653104989413" ENDIANNESS="LITTLE" TYPE="zfs_member" USAGE="filesystem" PART_ENTRY_*…
                             (a freed spare KEEPS a label, and it carries no LABEL and no UUID — no pool name, no pool guid)
POST /pools/gtvdev/attach {"existingDiskId":"…-part2","newDiskId":"…-part4","replace":true}
  -> 400 "Ineligible disk selection: partition '…-part4' carries a signature (TYPE=zfs_member) — clear it first if the partition is really free"
zpool labelclear -f …-part4 -> exit 0
blkid -p …-part4 -> exit 0:  PART_ENTRY_SCHEME="gpt" PART_ENTRY_UUID="f29fe9ef-…" PART_ENTRY_TYPE="0fc63daf-…" PART_ENTRY_NUMBER="4" PART_ENTRY_OFFSET="1640448" PART_ENTRY_SIZE="819200" PART_ENTRY_DISK="8:48"
wipefs -n …-part4 -> nothing, exit 0
the same replace -> 202 (no confirm), job zpool.replace completed in 0.2 s
zpool status gtvdev -> logs: …-part4 ONLINE; spares section gone; data/special/dedup/cache unchanged
blkid -p …-part2 (replaced away) -> exit 0, PART_ENTRY_* only (ZFS cleared the old log leaf's label)
existingDiskId = the stripped disk id -> 400 "'…HOT9' names more than one device in pool gtvdev (data …-part1, log …-part4,
       cache …-part3, special …-part5, dedup …-part6) — name the one you mean by its device"
newDiskId = the stripped disk id -> 400 "disk '…HOT9' is not available (status: pool_member, pool 'gtvdev')"
newDiskId = …-part9 (no such partition) -> 400 "partition '…-part9' not found"
attach (mirror) the blank 200 MB …-part2 onto the 400 MB data leaf …-part1 -> 202; job failed JOB_FAILED
       "cannot attach …-part2 to …-part1: device is too small"     (ZFS's own refusal; nothing changed)
```

The integration spec of the same contract, `vdev-remove-byid-api.spec.ts`, was re-run in row 7: **6 passed** (its test
315, the D1 failure of wave 3, included).

Fixtures committed verbatim under `packages/daemon/src/fixtures/zfs/` with a NOTES.md section "partition probes":
`blkid-p-zfs-member-partition.txt`, `blkid-p-freed-spare-partition.txt`, `blkid-p-blank-partition.txt` (all exit 0) and
`lsblk-partition-probe.json` (`PARTITION_PROBE_ARGS` on a free partition). Every partition `blkid -p` on this node
exits 0 — a partition always reports its `PART_ENTRY_*` keys; exit 2 was seen only on a blank whole disk (wave 3 R3).

**Verdict: PROVEN** — the repro that answered "not found" in wave 3 now replaces the log partition; a labelled
partition is refused naming the signature; the blank shape (exit 0, `PART_ENTRY_*` only) is what the gate lets through.
Side fact: the gate does no size check; an attach of a smaller partition reaches ZFS, which refuses it in the job.

---

## Row 2 — nf.1 D2: a recursive apply stops at a mount it did not name

`r2-walk-boundary.sh`. Pool `w3r2` on a 1 GiB sparse file vdev; `w3r2/a` and the named child `w3r2/a/b` through the API;
files `/w3r2/a/f1`, `/w3r2/a/sub/f2`, `/w3r2/a/b/f3`; the node's own nfsd exporting `127.0.0.1:/srv/w3r-nfs` (513
entries: `top` + 10 dirs × 50 files, all root:root), mounted by hand at `/w3r2/a/nfs` (nfs4, hard, vers=4.2). The export
was added after both `zfs create`s (wave 3 N5: a dataset mount runs `exportfs -ra`, which drops runtime exports).

```
findmnt -R /w3r2 -> /w3r2 (zfs) ├ /w3r2/a (zfs) ├ /w3r2/a/b w3r2/a/b (zfs) └ /w3r2/a/nfs 127.0.0.1:/srv/w3r-nfs (nfs4)
server side before: 501 × root:root 644, 12 × root:root 755; listing sha256 abe5c6f9e2d8ff1e

PUT /pools/w3r2/datasets/a/access {"owner":"nobody","applyToExisting":true} -> 409 code f930486ad159
   "It crosses the child datasets mounted under '/w3r2/a': w3r2/a/b (/w3r2/a/b)."
   "It does not enter the other filesystems mounted under '/w3r2/a' — not changed: /w3r2/a/nfs (nfs4)."
resent -> 202 job bc9ffb5a completed in 0.2 s, result "notChanged":["/w3r2/a/nfs (nfs4)"],
   last progress "find -P /w3r2/a/b -xdev ( -path /w3r2/a/b/.zfs ) -prune -o -exec /usr/bin/chown -h nobody {} +"
dataset side after: /w3r2/a, f1, sub, sub/f2, b, b/f3 -> nobody:root;  /w3r2/a/nfs, nfs/top -> root:root
server side after: identical listing, sha256 abe5c6f9e2d8ff1e
```

With the NFS server blocked (`nft table inet w3r2`, tcp/2049 dropped on output; `timeout 3 stat -f /w3r2/a/nfs` → 124):

```
(i) challenge and resend while blocked, owner daemon:
   409 in 0.21 s (the same three warnings, no word that the mount is dead) -> 202 -> job failed in 2.1 s JOB_FAILED
   "No permissions were changed: /w3r2/a/nfs (nfs4), mounted under '/w3r2/a', did not answer a 2 s liveness probe. The
    walk does not enter it, but it reads its mountpoint and would hang there with the lock held — unmount it or bring its
    server back, then apply again"
   no find/chown process left; dataset side still nobody:root everywhere; server listing unchanged
(ii) challenge while live (owner nobody, after a live apply to daemon), block, resend the code:
   202 -> job failed in 2.1 s, the same sentence; dataset side still daemon:root; server listing sha256 abe5c6f9e2d8ff1e
```

A first run of (ii) had a script bug (b): the probe called itself without `bash`, so the block did not happen and the
apply ran live (owner daemon, completed, NFS untouched — `out/r2-live-then-block-scriptbug.log`). Fixed, re-run as above.

**Verdict: PROVEN** — the confirm names the mount as not changed; the walk never touched the NFS server's files (the
server-side listing hash is the same before, after the live applies and at the end); the named child dataset was
walked; with the server blocked the job refused in 2 s before changing anything, both when confirmed while blocked and
when the block came between confirm and resend. Note: the door does not probe liveness, so the operator confirms and
then reads the refusal from the job (the story says "refuses before touching anything", which holds).

---

## Row 3 — nf.2 D3: the busy gate with fuser and no lsof

`r3-busy-unmount.sh`; `/mnt/w3r3` created through `POST /mounts` (nfs, `127.0.0.1:/srv/w3r-nfs`).

```
node# command -v lsof -> (none);  command -v fuser -> /usr/bin/fuser (psmisc)
holder: setsid bash -c 'exec 3</mnt/w3r3/top; exec -a w3r3-a sleep 3600'   -> pid 713845
fuser -vm /mnt/w3r3 -> "root kernel mount /w3r2/a/nfs"; "root 713845 f.... sleep"
bystander (no open file): w3r3-bystander pid 713862
POST /mounts/%2Fmnt%2Fw3r3/state {"action":"unmount"} -> 409 code ec0d0a1725ec
   "'/mnt/w3r3' is busy — 1 process(es) are holding it"
   warnings: "Unmounting '/mnt/w3r3' will be forced (lazy unmount); these holders lose access:", "sleep (pid 713845)"
resent -> 202 job 60888a8e completed, progress "Unmounting /mnt/w3r3 (lazy)", {"unmounted":"/mnt/w3r3"}
after: /mnt/w3r3 NOT mounted; w3r3-a alive, fd 3 -> "/top", still reads "hi"; bystander alive; fstab line kept (1)
```

fuser's "kernel mount" row (the other mount of the same NFS superblock, row 2's `/w3r2/a/nfs`) was not listed as a
holder. A process holding a file only through `/w3r2/a/nfs` was not listed for `/mnt/w3r3` either (`samesb`: no confirm,
plain unmount) — fuser -m did not over-report across the two mounts of one export.

The new-holder check (`newholder`): mount again, holder `w3r3-b`, challenge (409 names `sleep (pid 713970)` only), then
a SECOND holder `w3r3-c` (pid 713987) opens before the resend:

```
resend with the code -> 202 -> completed "Unmounting /mnt/w3r3 (lazy)"      <- w3r3-c was detached, never named
```

**Verdict: PROVEN for D3** (the confirm lists the holder fuser found; the forced unmount detached the mount and only
that — the holder kept its open file, the bystander and the fstab line were untouched). **Found: D10** — a holder that
appears between the challenge and the resend is force-detached without having been named: the route lists the holders
again on the resend and the job compares against that second list, not the one the operator confirmed.

---

## Row 4 — nf.2 D5: cleanup lists and wipes the data leaves only

`r4-cleanup-leaves.sh`; pool `w3r4` through `POST /pools`: data hot20, log hot21, cache hot22, spare hot23 (512 MB each).

```
wipefs -n before: every -part1 carries 4 × zfs_member; hot20/21 with LABEL w3r4 UUID 1599436143226448872, hot22/23 none
DELETE /pools/w3r4?cleanup=true -> 409 code f2ac61f6dc92
   "Disks to wipe: scsi-…HOT20-part1, scsi-…HOT21-part1."
   "scsi-…HOT22-part1 is not wiped: a cache (L2ARC) device's ZFS label names no pool."
   "scsi-…HOT23-part1 is not wiped: a hot spare's ZFS label names no pool (a spare can serve other pools)."
resent -> 202 job 3b5717be completed in 2.8 s:
   "wiped":[HOT20-part1, HOT21-part1], "zapped":[HOT20, HOT21],
   "skipped":[{HOT22-part1, "not cleaned: a cache (L2ARC) device's ZFS label names no pool"}, {HOT23-part1, "…hot spare…"}]
wipefs -n after: hot20, hot21 -> no partitions, no signature;  hot22, hot23 -> GPT + -part1 4 × zfs_member (unchanged)
```

**Verdict: PROVEN** — the confirm's "Disks to wipe" is exactly the data and log leaves, the cache and spare are named
with the reason, and the job wiped (and zapped) exactly those two disks and left the other two as they were.

---

## Row 5 — cr.33b: a replication run holds its source

`r5-mover-claims.sh`. Source pool `w3r5s` (file vdev), dataset `w3r5s/src` with 200 MiB of random data, snapshots `s0`,
`s1` (API). Destination pool `w3r5d` (`failmode=wait`) on a dm-linear over a loop over a 1 GiB sparse file. Local task
`w3r5rep` `w3r5s/src → w3r5d/rep`, disabled. `dmsetup suspend w3r5d` holds the receive in the kernel.

```
16:58:25 dmsetup suspend w3r5d; POST /replication/tasks/w3r5rep/run -> 202 {"started":true}
running: 8bd78685 zfs.replicate "zfs send w3r5s/src@snapshot-2026-10-15T16-58-26-312Z | zfs recv w3r5d/rep"
node# ps -> zfs send Dsl anon_pipe_write;  zfs recv -o readonly=on Ds cv_wait_common
PUT …/src/snapshots/s1 {"newName":"s1r"}     -> 202 job cfc4abe9 "queued" (no confirm for a snapshot rename)
POST …/src/snapshots/s0/rollback?force=true -> 409 "Destroyed by force: w3r5s/src@s1, w3r5s/src@snapshot-…-312Z."
                                               resent -> 202 job e03a8233 "queued"
t+15, 25, 36, 46 s: rename and rollback both
   queued | "waiting for zfs.replicate (job 8bd78685-5c39-4114-99f8-96262d775232) on Dataset 'w3r5s/src'"
16:59:11 (t+46 s) dmsetup resume -> replication completed 2 s later {"mode":"full", "bytesEstimated":210090096, "holdTag":"anas-repl-684abe8ac24d"}
rename   -> completed {"renamed":"w3r5s/src@s1","to":"w3r5s/src@s1r"}
rollback -> failed STATE_CHANGED "Snapshot 'w3r5s/src@s0' changed since you confirmed (was: w3r5s/src@s1,
            w3r5s/src@snapshot-…-312Z; now: w3r5s/src@s1r, w3r5s/src@snapshot-…-312Z) — nothing was done; confirm again"
zfs list -> w3r5s/src@s0, @s1r, @snapshot-…-312Z; w3r5d/rep@snapshot-…-312Z   (nothing rolled back)
```

The run lasted 48 s. The STATE_CHANGED sentence also shows nf.2 D7's `was: …; now: …` live.

Then the "confirm again" (`r5b-rollback-held.sh`): a fresh challenge listed `w3r5s/src@s1r, w3r5s/src@snapshot-…-312Z`
as "Destroyed by force"; the job failed JOB_FAILED "cannot destroy 'w3r5s/src@snapshot-…-312Z': dataset is busy" — the
replication's user hold `anas-repl-684abe8ac24d` sits on that snapshot — after `rollback -r` had already destroyed `s1r`.
Left: `s0` and the held snapshot, no rollback. That is **D11**.

**Verdict: PROVEN** — while a replication run lasted, a snapshot rename and a forced rollback of its source both
waited, naming the run's job; after the run the rename ran and the rollback re-gated (`STATE_CHANGED`, nothing done).

---

## Row 6 — cr.35r: GET /v1/status answers every section

`r6-status.sh`, three calls through the gateway and one on the daemon socket:

```
GET /status -> 200 in 168 / 170 / 198 ms;  socket -> 200 in 0.21 s
keys: ahrPools, disks, jobs, node, pools, shares, unavailable, warnings;  "unavailable": []  (every call)
pools: gtbackup, gtiscsi, pvfix, sysfix ONLINE;  disks total 3 (unknown 3: QEMU disks report no SMART verdict);
shares smbCount 3, nfsCount 1;  jobs 20;  ahrPools 0;
warnings: the two standing share cards for /testpool/share1 (testpool is exported in the baseline)
```

**Verdict: PROVEN** — all twelve sections read inside their 12 s budget on an idle node; none listed as unavailable.
(A hung section was provoked in wave 3 N4/N5, not here.)

---

## Row 7 — cr.25b leftovers: the specs wave 3 classified (a)

`testpool` imported for the run and exported again; hot disks 20/21 attached for pools-act-api and detached after; LIO
(`targetcli-fb python3-rtslib-fb`, no recommends) installed for the iSCSI specs and purged (autoremove took exactly the
three packages it had pulled; ADOCK's and ANAS's apt hooks fired, `AnyEvent.pm` and `index.html.tpl` hashes unchanged).

| Spec | Wave 3 | Re-run before the fix | Class | Fix | After |
|---|---|---|---|---|---|
| pvepool-api 314 | `anas-` prefix reserved (cr.20) | same 400 "'anas-' is reserved for scheduled snapshots" | (a) | the snapshot name `'anas-proof-snap'` → `'proof-snap'` (the request and the not-contains check, one token each) | file **12/12 passed** (with LIO; 503 fails `lio-not-installed` without it, (c) as in wave 3) |
| ident-iscsi 241 | `IDENTITY_MISMATCH` ≠ expected | same | (a) | `toBe('CONFIRMATION_REQUIRED')` → `toBe('IDENTITY_MISMATCH')` (cr.32: a replay against a re-created LUN is `IDENTITY_MISMATCH`, WAVE3-DESIGN §3) | 241 and 202 **2 passed**; 279 not run (it backs up to the PBS VM, off limits) |
| ident-mounts-repl (e) 229 | Remove confirms (cr.39) | 409 CONFIRMATION_REQUIRED at the final Remove; left the `ident4-cifs` fstab line (removed through the API) | (a) | the final `runJob(… DELETE …)` passes the code from a first DELETE's 409 (one line) | **1 passed**; fstab hash back to `b3c85fb4` |
| pools-act-api 196 | forced create confirms (cr.36) | 409 on `POST /pools {…, force:true}` | (a) | `force: true` removed from the create body (the disk is a fresh blank image; the test is about the destroy flow) | file **9/9 passed** |
| vdev-remove-byid 315 | D1 | — | D1 fixed | none | file **6/6 passed** |
| vdev-consumers 225 | cache + spare not wiped (D5) | "…HOT9-part3 carries no ZFS label" → 4 × zfs_member | (a), by design since nf.2 D5 | **not fixed** — the test asserts the vdevs.1 contract "all six partitions labelcleared, the disk available"; D5 keeps the cache and spare leaves on purpose, so the loop, the whole-disk check and the `available` poll all change (several lines) | 2 passed, 1 failed |
| cloud-tasks-api 592 | `errors` empty (D9) | `bad.errors.length` 0 at line 640 | (a) + (c) | **not fixed** — see below | 6 passed, 1 failed, 2 did not run (serial) |
| smbsvc-api 5 (AHR half) | `anas-` reserved, then the `ahrpv` pin | not run | — | the spec creates AHR pool `ahrpv`, which the brief rules out (stale mdadm.conf pin) | — |
| ahr-cache-review shape 3 | Destroy refuses a foreign PV (cr.22) | not run | — | the fixture's VG is `gtcache`, ruled out by the brief | — |

**cloud-tasks-api 640–642.** The spec asks the wrong-password preview for an rclone error line AND `truncated: false`
("finish inside the 120 s ceiling"); cr.35r cut the preview to 12 s (`PREVIEW_TIMEOUT_S`). What rclone v1.60.1 writes
in that window varies on this node (`r7-preview-badpass.sh`, run after the spec's own `afterAll` had already removed the
fixture's sftp user, so these are "auth failure" probes, not the spec's exact remote): one hand run under `timeout 12`
wrote nothing to stderr and exited 124 (the preview's honest `truncated: true, errors: []`); the next failed in 0.1 s
with "handshake failed: EOF", and the API preview the same minute answered 200 in 11.3 s with the error line and
`truncated: false`. So D9's fix (keep the last raw line when truncated) does not help when rclone has written nothing,
and the spec's three assertions sit on a race with the 12 s ceiling. Fixing it means deciding what the preview must
show for an auth failure that outlasts 12 s — not a one-liner.

**Verdict:** four (a) fixed with one-line edits (commit 35144ec, with the row-1 fixtures), all four specs green after; vdev-remove-byid green (D1);
vdev-consumers 225 and cloud-tasks-api 592 are (a) but need more than one line, reported; two specs not run under the
brief's AHR-name rule. The edited specs pass eslint.

---

## Product defects

| # | Severity | What | Repro | Suspected file:line |
|---|---|---|---|---|
| **D10** | minor (a forced detach wider than what was confirmed; no data touched, the holder keeps its open files) | A busy Unmount/Disable/Remove confirms the holders it listed, but the resend lists the holders AGAIN and the job's `assertNoNewHolders` compares the job-time listing with that second list. A process that opens a file on the mount between the challenge and the resend is lazily detached without ever being named; the "a holder the confirm did not name refuses the job" rule only covers the sub-second gap between the resend and the job start. The holder set is not in the signed request (`validated: { mountpoint, action }`) or in the bound scope | row 3 `newholder`: holder b → 409 naming b only → holder c opens → resend → 202, completed "(lazy)" | `routes/mounts.ts:803-821` (holders re-listed at the resend; `validated` at `:809` binds no holders), `:832` (`assertNoNewHolders(mp, holders)` gets the resend's list); the Remove door the same at `:891-931` |
| **D11** | minor (a refusal after a partial destroy within the confirmed set) | A forced rollback's confirm lists a snapshot that carries a user hold (the replication's `anas-repl-*` incremental base) under "Destroyed by force"; `zfs rollback -r` then destroys the newer unheld snapshots, fails "cannot destroy '…': dataset is busy" on the held one, and the rollback is not done. The confirm does not say the held base blocks the rollback (or that destroying it would break the task's next incremental) | row 5b: after one replication of `w3r5s/src`, `POST …/snapshots/s0/rollback?force=true` → 409 lists `@s1r, @snapshot-…`; resend → job failed "dataset is busy"; `zfs list` → `@s1r` gone, the held snapshot kept | `routes/datasets.ts:2085-2095` (the force scope is read without `zfs holds`), `:2119` (`rollback -r`) |

---

## Node state at the start and the end of the pass

`out/node-state-start.log`, `out/node-state-end.log` (`docs/probes/wave3b-node/node-state.sh`).

| Item | Start | End |
|---|---|---|
| ADOCK | CT 9900 `ingress-default` stopped, protection 1, onboot 0; adock/adockd active; `/adock/` 401 | same |
| `ls /anas /adock` | No such file or directory (both) | same |
| `pct list` | 9900 stopped `ingress-default` | same |
| `zpool list` | gtbackup, gtiscsi, pvfix, sysfix ONLINE; testpool exported | same (testpool imported for row 7, exported again) |
| `/etc/fstab`, `/etc/exports`, `smb.conf` | `b3c85fb4`, `f1e3ca20`, `46779719` | same |
| `/etc/mdadm/mdadm.conf` | `b86d1edd` (the three stale lines) | same — not edited; no AHR pool created |
| `AnyEvent.pm` | `0aad1102` | same |
| `index.html.tpl` | `7e731c16` before the deploy, `58b75a9a` after it (bundle token re-stamped) | `58b75a9a` (apt hooks ran twice, no change) |
| VGs / md / dm / extra loops / nft tables / NFS mounts | none (loop0/1 = pvepool fixture) | same |
| hot disks | HOT1, HOT2 | same (HOT9, HOT20–23 attached and detached; hot20–23 images deleted; the pre-existing hot9 image left) |
| `/etc/anas/rclone.conf` | 0 bytes | 0 bytes (the cloud spec's fixture captured and restored it) |
| failed units | `anas-cloud-gtcancel`, `zfs-import@anasactimport`, `zfs-import@anascomp` | same |
| packages | no targetcli-fb, rtslib, lsof | same (LIO installed and purged in row 7) |
| `w3r*` objects | — | none (`/var/tmp/w3r` removed; no pool, mount, export, nft table, task, remote or process left) |
| anasd | pid 710378 after the deploy | pid 710378, NRestarts 0, `/v1/health` abandonedCommands `[]` |

## Summary

| Row | Verdict | One line |
|---|---|---|
| R0 deploy | PROVEN | `5b36fbe` deployed; 2136 dist files identical host vs node |
| 1 nf.1 D1 | PROVEN | `-part2` replaced by a cleared `-part4`; a labelled partition refused naming `TYPE=zfs_member`; `blkid -p` fixtures (zfs_member, freed spare, blank — all exit 0) committed |
| 2 nf.1 D2 | PROVEN | confirm says `not changed: /w3r2/a/nfs (nfs4)`; NFS server listing hash unchanged; child dataset walked; blocked server → job refuses in 2 s, nothing changed |
| 3 nf.2 D3 | PROVEN, D10 found | fuser's holder named in the confirm; the lazy unmount detached the mount only; a holder that appears between challenge and resend is detached unnamed (D10) |
| 4 nf.2 D5 | PROVEN | "Disks to wipe" = data + log; cache and spare named and kept; the job wiped exactly those |
| 5 cr.33b | PROVEN, D11 found | rename and forced rollback waited 46 s "waiting for zfs.replicate (job …)"; rename ran, rollback re-gated STATE_CHANGED; a forced rollback over the held replication base fails half-way (D11) |
| 6 cr.35r | PROVEN | GET /v1/status 200 in ~170 ms, `unavailable: []`, all sections |
| 7 cr.25b | RUN, classified | four (a) fixed with one-line edits and green; vdev-remove-byid green; vdev-consumers 225 and cloud-tasks-api 592 (a), more than one line; smbsvc-api 5 and ahr-cache-review 3 not run (brief's AHR names) |
