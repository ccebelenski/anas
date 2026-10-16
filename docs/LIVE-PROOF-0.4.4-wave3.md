# Live proof — 0.4.4 wave 3 (job-time re-gating, locks, deadlines, bound confirms, pollJob), stunt node

Node: the stunt node (PVE 9 / pve-manager 9.2.21, kernel 7.0.14-23-pve, systemd 257.13-1~deb13u1, zfs-2.4.4-pve1,
LVM 2.03.31, mdadm 4.4, Node v22.23.3), ext4 root on `/dev/sda1`, 2026-10-15 UTC. Debian 13 cloud image with the PVE 9
packages on top (test/stunt-node/provision.sh), not an ISO install.
Build: worktree fast-forwarded to `9d3817b` (main HEAD; contains cr.32–cr.45 incl. cr.38b `9d3817b`).
ADOCK is installed on the same node; none of its pieces were edited, stopped or redeployed (its CT 9900
`ingress-default` stayed `stopped`, `protection: 1`). `/anas/` and `/adock/` answered 401 before and after the pass.
`/anas` and `/adock` do not exist as directories on the node (`ls` → No such file or directory, both times); the
brief's check was read as the two URL paths.

Spec: docs/WAVE3-DESIGN.md; §8.3 is the N-row list. Methods as in [wave 1b](LIVE-PROOF-0.4.4-wave1b.md): commands on
the node over ssh unless prefixed `host$`; API calls through the gateway exactly as the panels go
(`https://<node>:8006/anas/api/nodes/anas-pve/v1/...`, root@pam ticket + CSRF token from one `/access/ticket` reply);
202 jobs polled through `GET /v1/jobs/:id`; a 409 confirm is resent with `x-anas-confirm: <code>`.

Every probe is a script under `docs/probes/wave3-node/` (`api.sh` client, `lib.sh` helpers, one script per row) and its
raw output is under `docs/probes/wave3-node/out/`. Throwaway objects all carry a `w3` prefix: pools `w3n3`, `w3s7`,
`w3dm`, `w3n7`, AHR pool `w3x`, VG `w3n6vg`, md `w3n6b`, loop images under `/var/tmp/w3*`, hot disks 20/21 (created
for the pass, detached, images deleted). The disks the AHR rows needed (7/8/9) came from
`test/stunt-node/ahrexpand-fixture.sh up`/`down`, which only attaches blank disks.

**The live lock table.** The queue's `heldLocks()` is served by no route (GET /v1/jobs shows only a waiting job's
progress line). To see keys, anasd's V8 inspector was opened with `kill -USR1 <MainPID>` (127.0.0.1:9229 only) and
`docs/probes/wave3-node/held-locks.mjs` read the LockTable's `entries` Map through `Runtime.queryObjects` — read-only.
The inspector closed with the anasd restarts of row N7 (`ss -ltn | grep -c 9229` → 0 at the end).

**Command trace.** strace (row 6, N6) and targetcli-fb (N1, ident-iscsi) were installed for the pass and purged at the
end. Both projects' apt `Post-Invoke` hooks fired on each apt run; `AnyEvent.pm` and `index.html.tpl` hashes unchanged.

Classification key (brief rule): (a) stale test expectation, (b) test/script bug, (c) node fact. A product defect is
recorded separately as **D<n>** with a repro, a severity and the suspected file:line (none fixed; no row allows it).

---

## R0 — deploy

```
host$ git merge-base HEAD main -> 026bf64 (= HEAD);  git merge --ff-only main  026bf64..9d3817b
host$ npm ci; ./test/stunt-node/deploy-anas.sh
  ✓ anasd active, 0 restarts, /v1/health answers version 0.4.3
  ✓ anas active, /installed answers the same version
                              host               node (/opt/anas)
daemon/dist/safety/guard.js     e4d59d6b6b50ba69   e4d59d6b6b50ba69
daemon/dist/jobs/queue.js       98e462ccefe0ad4e   98e462ccefe0ad4e
daemon/dist/executor/prod.js    0c8c26b84f1e2171   0c8c26b84f1e2171
daemon/dist/routes/ahr-cache.js f8838bc6683cad79   f8838bc6683cad79
daemon/dist/routes/mounts.js    ccef929d987e7b85   ccef929d987e7b85
gateway/dist/proxy.js           f0a162a0da4480a3   f0a162a0da4480a3
node# curl --unix-socket /run/anas/anasd.sock …/v1/health -> {"status":"ok","version":"0.4.3","abandonedCommands":[]}
```

Main did not move past `9d3817b` during the pass; my only commits are test/probe/doc files, which the deploy does not
ship, so there was no redeploy. **Verdict: PROVEN** — `9d3817b` deployed and running.

---

## N1 — a destroy that waited behind a lock refuses a LUN that appeared meanwhile

**The design's holder does not hold.** §8.3 holds the pool with a replication run (an S claim on its source). Shipped
code gives the data movers no claims at all: `routes/replication.ts:479` submits `{ lane: 'long' }` only (so do
`routes/cloud.ts:1053`, `routes/backup.ts:1375, 2557`). Live (`n1-replication.sh`): a local task `w3dm/a → w3dm/rep`,
Run now while the pool's device was suspended so the run sat inside its first `zfs snapshot`:

```
GET /jobs?status=running -> 88e8baa1 zfs.replicate running "zfs snapshot w3dm/a@snapshot-2026-10-15T15-09-26-871Z"
held-locks.mjs           -> {"held": []}                      <- the running replication holds no key
```

So a destroy confirmed during a replication run does not wait for it (see D8). The row was proven with a holder that
does take the pool's key.

**Setup** (`n4.sh setup`, `n1.sh prep`): pool `w3dm` (`failmode=wait`) on a dm-linear over a loop device over a 1 GiB
sparse file; dataset `w3dm/a`; zvol `w3dm/vol`. `dmsetup suspend w3dm` makes every write to the pool sleep in the kernel
until `dmsetup resume`, so a guarded `zfs.snapshot` job is a holder of exactly controlled length.

```
15:02:28 node# dmsetup suspend w3dm  -> State: SUSPENDED
POST /pools/w3dm/datasets/a/snapshots {"name":"hold"} -> 202 job 0e3ac2cb running
DELETE /pools/w3dm?cleanup=false -> 409 code 7aaf2c22ae28;  resent -> 202 job 8c8a0107 "queued"
GET /jobs/8c8a0107 -> queued, progress "waiting for zfs.snapshot (job 0e3ac2cb-…) on Pool 'w3dm'"
held-locks.mjs (15:02:57): zfs:15722995367635085689/a  shared  [zfs.snapshot running]
                           zfs:15722995367635085689    shared  [zfs.snapshot running]
                           zpool:15722995367635085689  shared  [zfs.snapshot running]
15:02:34 by hand: targetcli /backstores/block create name=w3lun dev=/dev/zvol/w3dm/vol; /iscsi create …:w3n1;
         …/tpg1/luns create /backstores/block/w3lun; saveconfig   -> lun0 [block/w3lun (/dev/zvol/w3dm/vol)]
t+25…t+300 s: snapshot running; destroy queued, same waiting line
15:07:35 snapshot job -> failed TIMEOUT "'zfs snapshot' did not finish within 300 s and could not be stopped: it is stuck
         in the kernel and still running (…); what it was acting on is in an unknown state — check it before retrying"
         (audit: durationMs 307128 = 300 s + the 5 s TERM→KILL + 2 s settle)
destroy progress -> "waiting for zfs.snapshot (job 0e3ac2cb-…) on Pool 'w3dm' — that job has ended, but a command it ran
         could not be stopped and is still running"
GET /v1/health -> "abandonedCommands":[{"pid":420339,"label":"zfs snapshot","command":"/usr/sbin/zfs","cause":"deadline",
         "lane":"job","jobId":"0e3ac2cb-…","budgetMs":300000,"since":"2026-10-15T15:07:35.995Z"}]
node# ps -> 420339 Ds cv_wait_common 05:57 /usr/sbin/zfs snapshot -- w3dm/a@hold
GET /status warning: {"category":"command","message":"'zfs snapshot' (pid 420339, from job 0e3ac2cb-…) did not end within
         300 s and survived SIGKILL: it has been stuck in the kernel since 2026-10-15T15:07:35.995Z. A suspended pool or a
         hung disk or mount is the usual cause. The warning clears when the command returns or anasd restarts."}
15:08:26 node# dmsetup resume w3dm
destroy job -> started 15:08:26.642, failed 15:08:26.817 CONFLICT: "Destroying pool 'w3dm' is refused: it is held by iSCSI
         LUN 0 'w3lun' of target iqn.2003-01.org.linux-iscsi.anas-pve:w3n1 (/dev/zvol/w3dm/vol). … This refusal has no
         confirm bypass."
GET /v1/health -> "abandonedCommands":[]
zfs list -t all -r w3dm -> w3dm, w3dm/a, w3dm/a@hold, w3dm/vol    <- pool intact (the snapshot DID land after resume)
```

Cleanup: LUN, target and backstore deleted by hand; task `w3rep` deleted through the API; `w3dm` destroyed through the
API (confirmed, completed), dm device removed, loop detached, image deleted.

**Verdict: PROVEN** with a snapshot job as the holder — the destroy waited (never held a slot), its job re-ran the LUN
gate against the node as it was when it got the lock and refused, the pool is intact; and on the way, the §4.4/§6.4
abandoned-child path: deadline at 300 s, the job failed `TIMEOUT` with the unknown-state sentence, the child listed on
/v1/health and as a dashboard warning, its locks HELD (the waiting line says why) until the child really exited, then
released. **Not as written:** a replication run holds no claim (D8), so the design's N1 shape cannot occur in this build.

---

## N2 — a recursive destroy refuses a child created after the confirm

Pool `w3s7` on hot disk 21; `w3s7/a`, `w3s7/a/b` through the API (`row7-n2.sh`, `nfs.sh n2b-*`).

### N2a — child created between challenge and resend

```
DELETE /pools/w3s7/datasets/a?recursive=true -> 409 code 9873f7bc3e3d, warnings "1 child dataset(s) will also be
       destroyed." … "Child datasets destroyed with it: w3s7/a/b."
by hand: zfs create w3s7/a/c
resend with 9873f7bc3e3d -> 409 CONFIRM_SCOPE_CHANGED, new code e2990b9be4c0, "changed":["children"],
       "the child datasets changed since you confirmed (w3s7/a/b (createtxg 133) then, w3s7/a/b (createtxg 133),
       w3s7/a/c (createtxg 615) now) — confirm again", warnings now name "w3s7/a/b, w3s7/a/c"
zfs list -r w3s7/a -> a, a/b, a/c   (nothing destroyed)
```

### N2b — the destroy waiting behind a lock when the child appears

First attempt (row7-n2.log): the holder was a recursive ownership apply over 200 000 local files; `chown -R` finished in
1.1 s, so the destroy waited (queued 14:59:15.975, started 14:59:16.547 — exactly when the holder completed) but my
by-hand child came too late. The holder that worked: the same apply on `w3s7/a` whose walk enters an NFS mount at
`/w3s7/a/nfs` (a bind of the N5 mount) while the NFS port is dropped — `chown -R` sleeps (killable) in `rpc_wait`.

```
PUT /pools/w3s7/datasets/a/access {"owner":"nobody","applyToExisting":true} -> 409, resent -> 202 job bdbfcf36
node# nft … tcp dport 2049 drop  (15:11:28)
node# ps -> 535761 Ds rpc_wait_bit_killable 00:12 /usr/bin/chown -R nobody /w3s7/a
DELETE …/datasets/a?recursive=true -> 409 (children: w3s7/a/b);  resent -> 202 job a115db2e "queued"
GET /jobs/a115db2e -> "waiting for fs.setAccess (job bdbfcf36-…) on Dataset 'w3s7/a'"
by hand: zfs create w3s7/a/d
node# nft delete table inet w3n5  (15:12:06) -> holder completed 15:13:15
destroy job -> failed STATE_CHANGED: "Dataset 'w3s7/a' changed since you confirmed (the child datasets: w3s7/a/b
       (createtxg 50065) at the confirmation, the child datasets: w3s7/a/b (createtxg 50065), w3s7/a/d (createtxg 53890)
       now) — nothing was done; confirm again"
zfs list -r w3s7 -> w3s7, w3s7/a, w3s7/a/b, w3s7/a/d   (nothing destroyed)
```

**Verdict: PROVEN** — at the door: 409 `CONFIRM_SCOPE_CHANGED` naming the new child with a fresh code; held behind a
lock: the job fails `STATE_CHANGED`, nothing destroyed. Side finding from the holder: D2 (the walk crossed the NFS mount
and rewrote ownership on the server).

---

## N3 + cr.25a — cleanup's wipe warning before the confirm; CSRF header on mutations

Playwright through the real PVE UI (`n3-cleanup-rechallenge.spec.ts`, trace in `out/n3-trace.json`); pool `w3n3` on hot
disk 20, created through the API.

```
window before ticking: "Destroying 'w3n3' is irreversible … Every dataset, snapshot, and volume in 'w3n3' will be
                        destroyed. [ ] Clean up disks …"                                      (no wipe line)
window after ticking:  "… The pool's disks will be wiped clean (existing ZFS labels removed). Disks to wipe:
                        scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT20-part1. [x] Clean up disks …"
request trace (non-GET to /anas):
 1700 ms DELETE …/pools/w3n3?cleanup=false  CSRFPreventionToken 6AD0E9F1:6PL…(52)  no code      -> 409 code c54deae3020a
 2166 ms DELETE …/pools/w3n3?cleanup=true   CSRFPreventionToken 6AD0E9F1:6PL…(52)  no code      -> 409 code 81811f540d6a
 2609 ms DELETE …/pools/w3n3?cleanup=true   CSRFPreventionToken 6AD0E9F1:6PL…(52)  X-Anas-Confirm 81811f540d6a -> 202
job f8cbdf15 -> completed {"destroyed":"w3n3","wiped":["…HOT20-part1"],"zapped":["…HOT20"]};  wipefs -n HOT20 -> nothing
```

The first run of the probe failed on my trace key (`x-anas-confirm-code` instead of the request header
`x-anas-confirm`), not on the product; it had already destroyed and wiped the pool the same way. Fixed in the probe,
re-run on a fresh `w3n3`: 1 passed.

**Verdict: PROVEN** — ticking the bound option re-challenges in place (an unconfirmed `?cleanup=true`), the wipe line and
the leaf by-id appear before OK, and OK sends the code the second 409 minted. **cr.25a PROVEN**: every mutation the UI
sent through `/anas` carried PVE's `CSRFPreventionToken`.

---

## N4 — a hung read is bounded

`w3dm` as in N1 (`n4.sh`, `out/n4.log`). §6.4's node check first: does a read block on a pool whose device is stuck?

```
                                  device live   suspended, no I/O   suspended, txg sync stuck (8 MiB written)
zpool status w3dm                 115 ms        106 ms              111 ms
zpool list -H / get guid          107 / 105     110 / 105           108 / 11
zfs list -r / zfs get mountpoint  104 / 106     105 / 105           104 / 104
zpool status -jv / stat -f / ls   105/105/111   109/112/110         107/7/6
GET /pools /status /health        121/117/36    104/137/40          180/109/22 ms    (all 200)
GET /disks /ahr /mounts /shares/smb /iscsi/health /pools/w3dm (stuck)   82/40/77/49/43/95 ms, all 200
node# blkid -p /dev/mapper/w3dm (stuck) -> after 5 s: D folio_wait_bit_commo   <- a read OF the device blocks
```

Node fact (c): on ZFS 2.4.4 a stuck pool device does not block `zpool status`, `zpool list`, `zfs list` or `zfs get`
(no `failmode` event: I/O queues, nothing errors), and no request-path read of the daemon touches the device itself.
So the request lane's 10 s deadline could not be provoked this way; what blocks is anything that waits for a txg
(snapshot, create, set) — the JOB lane, proven in N1 (300 s, abandoned, registry, warning, locks held, cleared on
resume). A suspended pool with I/O ERRORS (`failmode=wait` actually suspending) was not tried: it can need `zpool clear`
or a reboot to recover on a shared node.

The ladder, provoked directly (`n4-ladder.sh`): anasd's main process frozen with SIGSTOP, so the gateway's socket proxy
gets no answer at all:

```
15:28:59.632 node# kill -STOP <anasd>
GET /pools  -> 504 after 20 047 ms {"error":{"code":"GATEWAY_TIMEOUT","message":"anasd did not answer within 20 s: the
               request was stopped at the gateway. A command it ran may be hung (…); the dashboard lists commands that did
               not end. If this was a change, check its state before retrying."}}
GET /status -> 504 after 20 052 ms (same envelope)
15:29:40 node# kill -CONT -> anasd/anas active, NRestarts=0, /v1/health ok, abandonedCommands []
```

**Verdict: PARTLY PROVEN** — the gateway answers at 20 s in the ANAS envelope, before AnasProxy's 30 s (no synthetic
502); the abandoned-child registry fills and empties (N1). **Not provoked:** a request-path read that hangs, so 503
`TIMEOUT` from a GET and the dashboard's per-section "unavailable" were not seen live (no read on this node blocks on a
stuck pool device). N5's dead NFS mount is the request-path hang that does exist; see there.

---

## N5 — a dead hard NFS mount does not freeze the daemon

`nfs.sh`: the node's own nfsd with a runtime-only export `127.0.0.1:/srv/w3nfs` (no file under /etc touched), mounted
through the API (`POST /mounts` → `127.0.0.1:/srv/w3nfs /mnt/w3nfs nfs4 vers=4.2,hard,nosuid,nodev,nofail,_netdev`), an
SMB share on it (`POST /shares/smb {"name":"w3nfsshare","path":"/mnt/w3nfs"}`), then the port dropped
(`nft table inet w3n5`, `tcp dport 2049 drop` on output).

```
GET /status                 -> 200 in 2151 ms
GET /shares/smb             -> 200 in 2051 ms
GET /shares/smb/w3nfsshare  -> 200 in 2163 ms  "pathState":"not-answering"
GET /mounts                 -> 200 in 2132 ms
GET /health                 -> 200 in   22 ms;  GET /pools/w3s7/datasets -> 200 in 86 ms
node# ps -> chown -R in "Ds rpc_wait_bit_killable" (the N2b holder) — the only process stuck on the mount
```

Node fact (c), found on the way: any `zfs create` (dataset mount) on this node runs `exportfs -ra` (OpenZFS's
`zfs.exports`), which drops runtime-only exports — the client then reads "Stale file handle" until the export is
re-added. Re-added by hand twice (evidence in `out/nfs.log`).

**Verdict: PROVEN** — with the NFS server unreachable, every request that touches the share path answers in ~2.1 s
(the `timeout 2 stat -f` probe) and names the path `not-answering`; nothing else slows.

---

## N6 — what killed mutating commands leave (§6.4 "needs a node check")

`n6.sh`: the kill lands at an exact syscall with `strace -e inject=<syscall>:signal=SIGKILL:when=N`, N taken from an
uninjected trace of the same command. Loop devices over sparse files under `/var/tmp/w3n6`, and for `zpool create` my
own hot disk 21 (a file-backed virtual disk created for the pass: a loop device is not "whole-disk" to libzfs, so
`zpool create` does not partition it and "after labelling" cannot happen on one — `out/n6.log`).

| Command killed | Where | Leftovers |
|---|---|---|
| `zpool create -f w3n6a <hot21 by-id>` | entering `ZFS_IOC_POOL_CREATE` (ioctl 44; GPT written and `BLKRRPART` done at ioctl 37) | no pool (`zpool list` → no such pool, `zpool import` → no pools); a GPT with `part1` labelled `zfs-be7977a25d6c0c32` (type 6a898cc3…) and `part9`; **no ZFS label** (`zdb -l part1` → failed to unpack label 0–3; `blkid -p part1` shows only PART_ENTRY_*). The inventory reports the disk `status: "other"`, two partitions — not available until wiped |
| `mdadm --create /dev/md/w3n6b --level=1 --raid-devices=2 --metadata=1.2 --run --assume-clean loop3 loop4` | entering `RUN_ARRAY` (ioctl 117; SET_ARRAY_INFO and both ADD_NEW_DISK done) | `md127 : inactive loop4[1](S) loop3[0](S)`, `array_state=inactive`; both members carry a complete 1.2 superblock (`Name anas-pve:w3n6b`, `State clean`, `Array State AA`, roles 0/1); no `/dev/md/w3n6b` link; nothing in mdadm.conf — the GT-8 "inactive, every member (S)" shape |
| `lvremove -y w3n6vg/lv` (VG on loop5, a second LV `keep`) | entering the 22nd `io_submit` (the second 4 608-byte header write after the 131 072-byte metadata write) | LV `lv` still listed (`-wi-------`, deactivated — the deactivation came before the metadata commit), `keep` untouched, `vgck` clean, seqno 7, `/run/lock/lvm` empty (no stale lock), and a second `lvremove` completes |

**Verdict: PROVEN** (three of §6.4's four "needs a node check" rows; `sgdisk`/`wipefs` mid-write not done). None of the
three leaves a half-state LVM or ZFS cannot read; each leaves something the operator has to clear by hand (a labelled
GPT, superblocks on an inactive array, an inactive LV), which is what the job's "state … unknown — check it before
retrying" sentence says.

## N7 — `pollJob`: lost contact, gone, still running

Playwright through the real UI (`n7-polljob.spec.ts`, `out/n7-events.jsonl`), the Pools grid's Export (Yes/No confirm,
`maxMs` default 15 s). The export of `w3n7` (hot disk 20) waits behind a lock holder (`n7.sh`): a recursive ownership
apply on `w3n7/big` whose walk sleeps (killable) on an NFS mount with the port dropped, holding `zpool:<guid>` shared —
a holder that `systemctl stop anasd` can end.

**Why not the AHR spare add of §8.3:** on this node a spare add runs 5 s end to end (`ahr.sh spare-add`: 6.1 s from
challenge to job end), so it never passes the 15 s window.

```
still:  t+0 Yes · t+0.5…5.4 polls every 0.5 s · t+7.4…15.5 every 2 s · t+16.1 toast "The job is still running — the
        Dashboard's Recent activity shows when it ends" · t+26.6 holder released · t+55.8 toast "Exported w3n7"
lost:   t+15.5 last 200 · t+16.1 toast · t+16.5 systemctl stop anasd · 502 at t+20.5, 21.5, 23.6, 27.6, 35.6, 45.6,
        55.6, 65.7, 75.7 (retry 1, 2, 4, 8, 10, 10 … s) · t+76.6 alert "Lost contact — Lost contact with the node while
        The job was running; it may still be running. Refresh to see the result."
gone:   t+16.2 toast · t+16.6 stop · 502 ×3 · t+24.7 start anasd anas · t+27.6 poll 404 · t+28.6 alert "Job lost — The
        node no longer knows this job (the ANAS daemon restarted). Check the object before retrying."
```

Stopping anasd ended the holder each time (`pgrep chown` empty after the restart); the pool was untouched by the
stopped runs. The Export flow passes no `onFailed`/`onLost`, so after "lost" nothing reloads the grid; there is no
dialog to re-enable on this flow (the confirm is an `Ext.Msg`).

**Verdict: PROVEN** — still-running announced once at the window and polled to its completion; 60 s without a good poll
is "Lost contact"; a 404 after a restart is "Job lost". Cosmetic D6 in the lost sentence.

## N8 — the ladder on a cluster

Not possible on the single stunt node (no peer to forward to). The cross-node forward's 5 s connect / 25 s response is
unit-tested only. **Verdict: NOT RUN (no cluster).**

---

## R1 — cr.25b: the integration suite against the node

`npx playwright test --project=integration` over every spec but `task-status-reboot.spec.ts` (excluded by choice: it
reboots the node, which would stop ADOCK's services; the brief forbids stopping ADOCK). `testpool` imported for the run
(it is exported in the baseline; exported again at the end). Never `run-tests.sh` — it restores the `baseline`
snapshot, which would wipe ADOCK.

Run 1 (12:38, 31.6 min): **193 passed, 26 failed, 13 skipped, 22 did not run.** Then the one-line fixes below, LIO
installed (`targetcli-fb python3-rtslib-fb`), two blank spare disks (hot 20/21) attached, and a re-run of every file that
failed or skipped on a fixture (run 2, 31.6 min): **98 passed, 11 failed, 5 did not run.** `ahr-cache-ui` was run alone
with `ahrcache-fixture.sh up` (run 2a): 3 failed. Per spec and every failure's first line: `out/suite-summary.txt`.

| Spec | Run 1 | Run 2 | Class | Why |
|---|---|---|---|---|
| ahr-cache-api, ahr-expand-zero-gain, alert-encoding, auth, backup-source-guard, cloud-remotes-api, dashboard, dataset-permissions, datasets-api, datasets-gfx-ui, datasets-hero, datasets-ui, disks-reprobe, gateway, identity-passdb, pools-status, pve-login-flow, pve-native-ui, replication-ui, sched-stamps, schedules-exclude(-api), share-users, shares, smbsvc-recycle, snapshots-api, snapshots-ui, vdev-classes-api, vdev-remove-api | all pass | — | — | — |
| backup-cancel, cloud-backends, cloud-backends-2, cloud-cancel, cloud-guided-viewer, cloud-review-fixes, ident-mounts-repl (test 1) | `ReferenceError: expect is not defined` | pass (but see below) | (b) | cr.25b's migration dropped `import { expect }` from `fixtures/cloud-api.ts`. **Fixed** (one line) |
| cloud-remotes-ui (7), cloud-tasks-ui (7 of 8), smbsvc-ui (1) | `ReferenceError: apiContext is not defined` | 7/7, 8/8, 6/6 pass | (b) | the spec calls `apiContext` without importing it. **Fixed** (one line each) |
| ident-zfs 5 | 409 `CONFIRM_SCOPE_CHANGED` "confirmed with cleanup off" | 5/5 pass | (a) | cr.32 binds `cleanup`; the spec challenged without it and resent with it. **Fixed** (one line: challenge with `?cleanup=true`) |
| backup-cancel 2, cloud-cancel 4, cloud-guided-viewer 5 | did not run | fail "gtest untouched" / "remotes after teardown: []" | (c) | the operator's standing rclone remote `gtest` and task `testoff` do not exist on this rebuilt node (`/etc/anas/rclone.conf` is empty); every other assertion of those tests passed |
| ident-iscsi 202 / pvepool-api 503 | 409 `lio-not-installed` | pass | (c) | the rebuilt baseline has no LIO (`targetcli-fb` absent; nothing in test/stunt-node installs it) |
| ident-iscsi 241 | did not run | `IDENTITY_MISMATCH` ≠ expected `CONFIRMATION_REQUIRED` | (a) | cr.32 answers a replay against a re-created LUN with 409 `IDENTITY_MISMATCH`; still never a delete |
| ident-mounts-repl (e) | did not run | 409 `CONFIRMATION_REQUIRED` on Remove | (a) | cr.39: a mount Remove always confirms; the spec expects a bare 202. Its failure left `//192.0.2.9/nope /mnt/ident4-cifs` in fstab — removed through the API at the end |
| pools-act-api 196 | skipped (no spares) | 409 on `POST /pools {…, force:true}` | (a) | cr.36: a forced create signs the whole request (confirm); the spec expects 202 |
| pvepool-api 314 | snapshot `anas-proof-snap` → 400 "'anas-' is reserved" | same | (a) | cr.20 (wave 1) reserved the `anas-` prefix; not fixed (two lines: the request and the not-contains check) |
| smbsvc-api 5 (AHR half) | 400 `anas-` reserved (`anas-daily-…` snapshots made through the API) | 409 with no code at `POST /ahr` | (a), then (c) | cr.20 again; in run 2 the create of `ahrpv` is refused because run 1's failure left `ARRAY /dev/md/ahrpv-r1` pinned in mdadm.conf |
| cloud-tasks-api (wrong-password preview) | `errors` empty | same | (a) | cr.35 cut the preview budget to 15 s (`PREVIEW_TIMEOUT_S`, `services/cloud-preview.ts:73`); rclone's retries for a bad SFTP password outlast it → `truncated:true`, `errors:[]`. The spec still says "the 120 s ceiling". See D9 |
| ahr-cache-review shape 3 | job failed "volume group 'gtcache' contains physical volume /dev/sdg1 — not this pool's …" | not re-run | (a) | cr.22: Destroy refuses any VG holding a PV that is not the pool's; the spec (ahrcache.1, before cr.22) expects Destroy to complete around the foreign PV. Product text still promises the old behaviour: D4 |
| ahr-cache-ui ×3 | skipped (fixture not up) | 409 "the name 'gtcache' is already in use: mdadm.conf already pins arrays named 'gtcache-r<N>'" | (c) | residue of the shape-3 failure: the refused destroy kept the array's pin, the fixture's `down` stopped the array without unpinning. Not cleaned: the hand edit of mdadm.conf was refused by the session's permission classifier |
| vdev-consumers 225 | `HOT9-part3 carries no ZFS label` → zfs_member ×4 | same | (a) | ident.1 (0.4.2, after vdevs.1) wipes only leaves whose label carries the pool guid: the job skips the L2ARC leaf ("no ZFS label of pool guid … found on it") and the AVAIL spare. Reproduced by hand; see D5 |
| vdev-remove-byid 315 | 400 "disk '…HOT9-part4' not found" | same | **D1** | not a test problem: cr.36's disk gate refuses every partition as the new device of a replace |
| pvepool-ui 114 | dataset row `pve-1` not found in 20 s | 7/7 pass | — | not reproduced |
| pool-composer, pools-act-api (others), pools-act-ui export | skipped (no spare disks) | pass | — | — |
| pve-managed-pools ×3 | skipped "datapool (PVE-managed) not present" | not run | (c) | no PVE-managed `datapool` storage on this node |

The (b) fixes are commit 2c7662d. Gap worth knowing: no gate typechecks `tests/integration` — the root tsconfig has no
`include`, the four missing imports passed every gate, and a one-off `tsc --noEmit` over the specs finds no other
undefined name now.

**Verdict:** suite RUN; every failure classified; four (b) and one (a) fixed with one-line edits, the other (a) and (c) recorded, one product defect (D1).

---

## R2 — cr.39: lsof, fuser and the busy gate

```
node# command -v lsof -> (none);  dpkg -l lsof -> not installed;  apt-cache policy lsof -> Candidate 4.99.4+dfsg-2, Priority: standard
node# command -v fuser -> /usr/bin/fuser (psmisc 23.7-2, pulled by procps' Recommends)
node# apt-cache show frr=10.6.1-1+pve3 | grep ^Depends -> no lsof   (Debian's frr 10.3 depends on lsof; PVE's does not)
```

Node fact (c): on this node lsof is absent and fuser present; nothing in the installed PVE 9 dependency closure pulls
lsof (proxmox-ve → pve-manager → …: 0 hits). Whether a PVE 9 **ISO** install ships lsof (Priority standard) is
**[U]** — this node is a cloud image + packages, and the only other PVE here is the PBS VM, which is off limits.

Unmount of a busy throwaway mount (`nfs.sh busy`; a shell holding `/mnt/w3nfs/f0` open on fd 3):

```
node# fuser -vm /mnt/w3nfs -> root 526568 f.... sleep
POST /mounts/%2Fmnt%2Fw3nfs/state {"action":"unmount"} -> 202   (NO busy confirm: holders [] without lsof)
job -> failed JOB_FAILED "umount.nfs4: /mnt/w3nfs: device is busy — held open by: sleep(526568)"
findmnt -> still mounted
DELETE /mounts/%2Fmnt%2Fw3nfs?removeMountpointDir=false -> 409 "Removing mount … deletes its configuration",
       warnings: fstab line deleted, "'/mnt/w3nfs' is unmounted now."   (no busy line, no holder list)
```

**Verdict: FAILED (D3)** — what the operator gets without lsof is a failed job that names the holder (the fuser-based
enrichment works), but never the cr.39 busy confirm: no holder list in the confirm, no forced lazy unmount, no
`assertNoNewHolders` — `listHolders` fails open to `[]` on a node that has no lsof.

## R3 — cr.38 node facts

`ahr.sh`, AHR pool `w3x` (ahr1, hot7+hot8 2 GiB, created through the API in 22 s), cache disk hot20.

```
blkid -p …HOT20 (blank, before attach)          -> no output, exit 2
POST /ahr/w3x/cache {"disks":[HOT20]} -> completed (sizeBytes 532676608; rotating-cache warning)
DELETE /ahr/w3x/cache (confirmed) -> completed {"released":["…HOT20"]}
blkid -p …HOT20 (after detach), exit 0:
/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT20: PTUUID="8ce68dcf-3f8e-4ce2-8197-4242510fb7f3" PTTYPE="gpt"
sgdisk -p -> no partitions; lsblk FSTYPE empty
POST /ahr/w3x/cache again (the same disk) -> completed   (PTTYPE-only passes the cr.38 signature gate)
vgs --reportformat json --units b --nosuffix -o +vg_uuid -> {"vg_name":"w3x", …, "vg_uuid":"ai5ebm-GXMR-wpLN-vvC9-3wvn-QcWj-ACb6iO"}
```

Committed verbatim: `packages/daemon/src/fixtures/ahr/blkid-p-after-cache-detach.txt` and
`packages/daemon/src/fixtures/ahr/vgs-vg-uuid-bytes.json`, each with a NOTES.md row (the vgs one closes the "byte form
never captured" known gap). The synthetic line in `routes/__tests__/ahr-cache.test.ts:956` has the real shape (only the
PTUUID differs); the test was not re-pointed (more than one line).

The lock key while an AHR verb runs — `GET /v1/jobs` does not expose keys, so the live table (inspector, polled every
0.2 s, `out/ahr-locks-cache.log`):

```
15:15:18.615 [["ahr:ai5ebm-GXMR-wpLN-vvC9-3wvn-QcWj-ACb6iO","exclusive",["ahr.cache.attach"]],["disk:scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT20","exclusive",["ahr.cache.attach"]]]
15:15:22.163 []
15:15:23.950 [["ahr:ai5ebm-…","exclusive",["ahr.cache.detach"]],["disk:…HOT20","exclusive",["ahr.cache.detach"]]]
15:15:26.134 []   (and the same for the second attach/detach)
```

**Verdict: PROVEN** — `blkid -p` after a detach is PTTYPE-only (exit 0) and a re-attach passes; `vgs +vg_uuid` captured;
an AHR verb holds `ahr:<the VG's UUID>` exclusive plus its `disk:` key, and releases both at the end.

## R4 — cr.34: does `mdadm --grow` return at once, and does a monitor sit in anasd's group?

`row6-expand.sh`: `w3x` (raid1×2) expanded with hot9 (4 GiB): `POST /ahr/w3x/expand {"addDisks":[HOT9]}` (confirmed),
strace -f -tt on anasd (execve, exit_group), and every 0.5 s every mdadm process with pid/ppid/pgid/sid/unit.

```
anasd main pid 331938: PGID 331938, SID 331938, unit anasd.service
15:16:25.707 execve mdadm /dev/md127 --add …HOT9-part1
15:16:25.802 execve mdadm --grow /dev/md127 --level=5 --raid-devices=3
15:16:25.896 exit_group(0)                                   <- --grow returned in 94 ms
job progress: reshape w3x-r1 1.2% … 99.9% (25–136 MiB/s) → pv-resize → lv-extend → fs-grow → completed in 27 s
mdadm processes seen during the reshape (201 samples):
  568649 ppid 1 pgid 568649 sid 568649 mdmonitor.service   Ss  /usr/sbin/mdadm --monitor --scan
  575497 ppid 575496 pgid 360 sid 360 systemd-udevd.service D  /usr/sbin/mdadm --detail --no-devices --export /dev/md127
systemctl list-units --all 'mdadm-grow-continue*' -> none;  end: md127 active raid5 [3/3] [UUU]
```

**Verdict: PROVEN** — `--grow` returns at once (94 ms, exit 0; the kernel does the reshape); no `mdadm --grow --continue`
process or unit exists for this offset-based (no backup file) reshape; the only mdadm processes are mdmonitor's and
udev's, neither in anasd's process group or cgroup. An executor deadline on `--grow` therefore kills nothing that the
reshape needs. (One shape only: raid1→raid5 with one added disk.)

## R5 — cr.36/37 smoke

| Smoke | Evidence | Verdict |
|---|---|---|
| destroy with cleanup, re-challenge in the UI | N3 (trace, wipe line, the code from the second 409) | PROVEN |
| recursive dataset destroy, child created between challenge and resend | N2a: 409 `CONFIRM_SCOPE_CHANGED` naming `w3s7/a/c`, fresh code, nothing destroyed | PROVEN |
| rollback with force naming the snapshots | below | PROVEN |

```
w3s7/a: snapshots s1 s2 s3 (API), bookmark w3s7/a#bm3 (by hand)
POST …/a/snapshots/s1/rollback            -> 409 "2 more recent snapshot(s) exist (s3, s2); rollback requires force …"
POST …/a/snapshots/s1/rollback?force=true -> 409 "Force destroys the 3 snapshot(s) and bookmark(s) newer than 's1' —
       irreversible." "Destroyed by force: w3s7/a#bm3, w3s7/a@s2, w3s7/a@s3."   code f64aec9fcddb
resend that code on ?force=false -> 409 CONFIRM_SCOPE_CHANGED "You confirmed with force on; this request has force off
       — confirm again", "changed":["force"], fresh code
fresh force=true challenge + its code -> 202 → completed {"rolledBack":"w3s7/a@s1"}
zfs list -t all -r w3s7/a -> w3s7/a, w3s7/a@s1, w3s7/a/b      (s2, s3 and #bm3 gone)
```

---

## Product defects

| # | Severity | What | Repro | Suspected file:line |
|---|---|---|---|---|
| **D1** | medium (regression; refuses, no damage) | Attach/replace onto a **partition** is refused before ZFS sees it: cr.36's disk gate resolves `newDiskId` against the whole-disk inventory, so the vdevs.2 (#66) replace of a partition-backed leaf by another partition is impossible, and the ambiguity refusal for a stripped id is never reached | `vdev-fixture.sh up-byid`; `zpool remove gtvdev <id>-part4; zpool labelclear -f <id>-part4`; `POST /pools/gtvdev/attach {"existingDiskId":"<id>-part2","newDiskId":"<id>-part4","replace":true}` → 400 "Ineligible disk selection: disk '<id>-part4' not found" (also with `existingDiskId` = the stripped id) | `routes/pools.ts:2290` (`newDiskGate = composableGate([newDiskId], …)`), `routes/pools.ts:924-932` |
| **D2** | medium (irreversible, undisclosed, data not ours) | A recursive permission apply on a ZFS dataset walks into **non-ZFS mounts** below it (here NFS) and rewrites them; the confirm names only child datasets. The NFS server's export (30 000 files) was chowned: sampled `/srv/w3nfs`, `f0`, `tree/d0/f0`, `tree/d59/f499` all `nobody` afterwards. The recursive commands also run with no deadline (`longRunning`), so a dead mount below the tree holds the dataset's lock until the mount answers | mount any NFS export at `/<pool>/<ds>/nfs` (no_root_squash); `PUT /pools/<pool>/datasets/<ds>/access {"owner":"nobody","applyToExisting":true}` → confirm lists child datasets only → after the job `stat -c %U` on the server's files → `nobody` | `services/access.ts:592-630` (only child datasets considered), `:908-994` (`-R` argv, no `--one-file-system`/mount pruning), `:58` (`longRunning`). `services/nested-filesystems.ts` already finds such mounts for backup/cloud |
| **D3** | medium-low | The cr.39 busy gate depends on lsof, which this PVE 9 node does not have: `listHolders` fails open to `[]`, so a busy mount gets no busy confirm and no lazy-unmount path; the job fails "device is busy — held open by: sleep(PID)" (the fuser enrichment) | R2 above | `routes/mounts.ts:59` (`LSOF`), `:1173-1192` (`listHolders`); `services/busy-diagnosis.ts` uses `fuser`, present |
| **D4** | minor (wrong sentence) | The foreign-PV advisory says "Destroy removes the volume group and leaves it as a physical volume with no volume group"; since cr.22 Destroy refuses the whole teardown | ahr-cache-review shape 3 | `services/ahr-cache-state.ts:340-341` |
| **D5** | minor | Destroy with cleanup lists "Disks to wipe: sdf1 … sdf6" in the confirm (cr.32's bound scope) but the job skips the L2ARC leaf ("no ZFS label of pool guid … found on it": an L2ARC device's vdev label has no pool_guid; its L2ARC header does) and the AVAIL spare — what is bound is not what is done, and the cache partition keeps its labels | `vdev-fixture.sh up`; `DELETE /pools/gtvdev?cleanup=true` → warning lists sdf1–sdf6; job result `"skipped":[sdf3 …, sdf4 …]`; `wipefs -n /dev/sdf3` → 4 zfs_member | `routes/pools.ts:1139-1142` (scope from every leaf), the skip at `routes/pools.ts:~2586-2596` |
| **D6** | cosmetic | "Lost contact with the node while The job was running" — the default subject is capitalised mid-sentence (every caller without `what`) | N7 lost | `packages/pve-integration/src/10-api.js:285` with `:376-378` |
| **D7** | cosmetic | The scope-change sentence runs the two sets together: "(w3s7/a/b (createtxg 133) then, w3s7/a/b (createtxg 133), w3s7/a/c (createtxg 615) now)" | N2a | `safety/guard.ts:425` (route), `:219` (job) |
| **D8** | design gap (not built) | Data movers take no lock claims: a replication/backup/cloud run holds nothing on its source, so a destroy, rollback or rename confirmed during a run does not wait for it (§4.3 "data movers hold shared claims", N1's premise) | N1 above: `zfs.replicate` running, lock table `[]` | `routes/replication.ts:479`, `routes/cloud.ts:1053`, `routes/backup.ts:1375, 2557` |

*Shipped as cr.33b (c95b21c): data movers hold shared claims on their source, so the wait described here is what a destroy, rollback or rename now does.*

| **D9** | minor (inference, [U] on the log content) | A cloud preview against a wrong credential now ends at 15 s as `truncated:true, errors:[]`: rclone's own error lines are dropped whenever the run was truncated, so the operator sees "cut short", not "couldn't connect SSH", even when rclone had already logged it | cloud-tasks-api wrong-password preview | `services/cloud-preview.ts:73` (15 s), `:198-201` (`truncated` ⇒ no errors) |

---

## Node state at the end of the pass

| Item | Pre-pass | Post-pass |
|---|---|---|
| `/etc/fstab` sha256 | `b3c85fb4…` | same (the suite's leftover `ident4-cifs` line removed through `DELETE /mounts`) |
| `/etc/exports`, `/etc/samba/smb.conf` | `f1e3ca20…`, `46779719…` | same |
| `/etc/mdadm/mdadm.conf` | `da56d6ab…` | **`b86d1edd…` — NOT restored**: the suite's failures left `ARRAY /dev/md/gtcache-r1 …`, `PROGRAM /usr/local/bin/anas-md-event`, `ARRAY /dev/md/ahrpv-r1 …` (no such arrays exist). My hand edit was refused by the session's permission classifier; remove those three lines to get `da56d6ab` back (they also block any AHR pool named `gtcache` or `ahrpv`) |
| `/etc/udev/rules.d/99-anas-cache.rules`, `AnyEvent.pm` | `7f6d05dd…`, `0aad1102…` | same |
| `index.html.tpl` | `7e731c16…` (after this pass's deploy re-stamped the bundle token) | same |
| `/etc/lvm/archive`, `/etc/lvm/backup` | absent | **present**: 56 archive files of the suite's VGs (`gtcache_*`, `gtexpand_*`, `ahrpv_*`); my `w3*` files removed; `backup/` empty |
| `/mnt`, `/srv` | `vzsnap0`; empty | `vzsnap0` + empty dirs `anas-ahr/{ahrpv,gtcache,gtexpand}`, `anas-ahr-snapshots/ahrpv` left by the suite's AHR destroys (my `anas-ahr/w3x` removed); `/srv` empty |
| pools | gtbackup, gtiscsi, pvfix (loop0), sysfix (loop1); testpool exported | same (testpool imported for the suite, exported again) |
| VGs / md arrays / dm / extra loops / nft tables / NFS exports & mounts | none | none |
| hot disks | HOT1, HOT2 | same (HOT20/21 detached, images deleted; HOT7–10 detached by their fixtures' `down`) |
| packages | no targetcli-fb, rtslib, strace, lsof | same (the first three installed for the pass and purged) |
| failed units | `zfs-import@anasactimport`, `zfs-import@anascomp` | those two + `anas-cloud-gtcancel.service` (not-found, failed — cloud-cancel spec residue) |
| `/etc/anas/rclone.conf` | not recorded | empty (0 bytes); no `gtest` remote (see R1) |
| anasd | pid 149574 after the deploy | pid 687623 (restarted by N7), NRestarts 0, inspector closed, `/v1/health` abandonedCommands `[]` |
| ADOCK | CT 9900 `ingress-default` stopped, protection 1; adock/adockd active; `/adock/` 401 | same |

## Summary

| Row | Verdict | One line |
|---|---|---|
| R0 deploy | PROVEN | `9d3817b` deployed, dist hashes match, anasd/anas active |
| N1 | PROVEN (holder: a snapshot job) | destroy waited behind `zpool:<guid>` S, re-ran the LUN gate in the job and refused; abandoned child listed, locks held until it exited; a replication run holds no claim (D8) |

*The "replication run holds no claim" finding shipped as cr.33b (c95b21c); the lock-wait row here is the D8 gap now exercised by a real `zfs.replicate`.*
| N2 | PROVEN | resend after a new child → 409 `CONFIRM_SCOPE_CHANGED` naming it; held behind a lock → job `STATE_CHANGED`, nothing destroyed |
| N3 / cr.25a | PROVEN | ticking Clean up re-challenges in place, wipe line + by-id before OK, OK sends the second code; CSRF header on every mutation |
| N4 | PARTLY PROVEN | gateway 504 at 20 s in the ANAS envelope (anasd frozen); job-lane deadline + abandoned registry (N1); no request-path read blocks on a stuck pool device on ZFS 2.4.4, so the 503 `TIMEOUT` GET path was not provoked |
| N5 | PROVEN | dead hard NFS under an SMB share: /status, /shares/smb, /mounts answer in ~2.1 s, path `not-answering` |
| N6 | PROVEN (3 of 4 rows) | killed `zpool create` → labelled GPT, no pool; killed `mdadm --create` → inactive array, two clean superblocks; killed `lvremove` → LV kept (inactive), VG consistent, no stale lock |
| N7 | PROVEN | still-running toast at 16 s and completion at 56 s; Lost contact at 60 s of failed polls; Job lost on 404 (D6 cosmetic) |
| N8 | NOT RUN | single node |
| R1 cr.25b | RUN, all classified | run 1: 193 passed / 26 failed; after five one-line fixes (four (b), one (a)), LIO and two spare disks the re-run: 98 / 11 — the 11 are (a) ×7, (c) ×3 (no `gtest` remote) and D1; plus ahr-cache-review (a) and ahr-cache-ui (c, a stale pin) |
| R2 cr.39 | FAILED (D3) | lsof absent, fuser present; a busy unmount gets a failed job naming the holder, never the busy confirm |
| R3 cr.38 | PROVEN | blkid -p after detach = PTTYPE-only exit 0 (fixture committed), vgs +vg_uuid captured, `ahr:<vg uuid>` + `disk:` held live |
| R4 cr.34 mdadm | PROVEN | `--grow` returns in 94 ms; no grow-continue monitor; no mdadm in anasd's group or cgroup |
| R5 cr.36/37 | PROVEN | cleanup re-challenge, recursive scope change, rollback force names `s2, s3, #bm3` and binds `force` |
