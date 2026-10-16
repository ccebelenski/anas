# ANAS 0.4.4 wave 3: job-time re-gating, bound confirms, executor timeouts, job polling (design pass)

**Status:** design only, 2026-10-15, at main `fc596e1`. Nothing here is built. The coordinator inks the
rulings and cuts the stories; section 9 lists the proposed ones (cr.32 onwards). Inputs: the 2026-10-14
code review (H8, M1, M3, M5 second bullet, M5's two other UI items, §7's order), EPICS §2 (Safety
altitudes; the 0.4.3 retrospective's ruling (j) "Jobs re-read and re-gate … through the one `safety/`
helper"; ruling (l) "Fakes print captured output"; Ground truth first; Mounts), the identity audit's P1
pattern and its suggested order step 2, and the cr.12–cr.31 entries in EPICS §3.

**Evidence tags.** `[C]` = this repository at `fc596e1`, re-read for this pass; paths are relative to
`packages/daemon/src` unless they start with another top-level directory, and line numbers are at
`fc596e1`. `[P0n]` = a capture checked in under `docs/probes/wave3/` (stunt node: PVE 9.2.21, kernel
7.0.14-23-pve, OpenZFS 2.4.4, Node 22.23.3; dev host: Node 26.11.1). **[U]** = not verified; the reason is
given where it appears. Nothing was written, installed, imported or restarted on the node; the only
commands run there were the reads in `timing.sh` and a Node script piped on stdin that spawns `sh` and
`sleep` (P02).

How the inventories were made: four read-only passes over the route files (ZFS; AHR; iSCSI, schedules,
replication, backup and cloud; mounts, shares, identity, disks and jobs) and one over every executor call
site, each instructed to cite file:line and mark what it did not confirm. I re-read the load-bearing
lines myself (marked `[C]` where I did); rows I did not re-read keep the pass's citation and are marked
**[R]** like the review's own evidence level. Several review items were fixed since 2026-10-14; each
H8 item below carries a STILL TRUE / FIXED / PARTLY verdict.

---

## 0. Summary

| Piece | Recommendation |
|---|---|
| The one helper (H8, ruling (j)) | `safety/guard.ts`: a **guard spec** per verb names the object's lock keys, how to re-read the object, its **stable id** (is it the same object?), its **revision** (is it still in the state the request was computed from?) and the list of gate functions. The route runs the spec's gates (same functions) and binds id and revision into the confirm; the job runs `guarded(spec, body)`, which re-reads the object, compares id and revision, re-runs every gate and only then calls the body. A refusal in the job fails the job with the gate's own error code and sentence. Gates are written once and called from both doors; nothing else may re-implement them. |
| Per-object lock | **In the queue, not in the job body.** `submit` takes the spec's lock claims; `drain` starts a job only when all its claims can be granted (all-or-nothing, per-key FIFO, shared/exclusive). A job waiting for a lock does not hold one of the 4 slots, and its progress line names what it is waiting for. Keys are stable ids where the object exists (pool guid, dataset guid, AHR VG UUID, LUN serial, target IQN, uid/gid, disk by-id) plus a **name key** for every verb that changes a namespace (create, import, export, destroy, rename). Long jobs hold the lock only around the steps where ANAS itself changes the object (`ctx.release()` before a kernel wait, `ctx.reguard()` before the next act), never across a multi-hour wait. Long jobs may fill at most 3 of the 4 slots, so a short verb is never stuck behind four data movers. |
| Bound confirms (M3) | **Bind by default.** `guardConfirm` (the successor of `confirmGateBound`) binds the whole validated request (body + query flags) unless a field is listed by name as presentation-only; derived sets that decide the blast radius are bound as ids (the child-dataset guid set of a recursive destroy, the by-id disk set of create, cleanup and AHR create). A resend with a different flag or a changed set gets a fresh 409 `CONFIRM_SCOPE_CHANGED` that names what changed. |
| UI for bound flags (M3) | The confirm window keeps its checkbox, but ticking a bound option **re-challenges in place**: the window re-sends the same unconfirmed request with the new flag and replaces warnings and code (so "the pool's disks will be wiped" appears before the operator confirms). Safe only for verbs whose daemon confirm is unconditional; a daemon test pins that property for each such route. |
| Executor timeouts (M1) | A default deadline in `ProdExecutor` chosen by **lane** (an `AsyncLocalStorage` set by the route hook and by the queue): **10 s per command on the request path, 300 s in a job or in the background**, explicit per-call opt-outs for the data movers and the long kernel waits (a reason string is required). On the deadline: SIGTERM to the child's **process group**, 5 s grace, SIGKILL to the group, and if the child still has not exited 2 s later the call **settles anyway** by rejecting with `CommandTimeoutError` (never an exit code a reader could take for "nothing there") and the child is recorded as abandoned (a process in uninterruptible sleep cannot be killed). A job whose child was abandoned **keeps its object locks** until the child really exits. |
| Request path answer on a timeout | Each verb keeps its existing convention: a gate fails closed (503 `TIMEOUT` naming the command and the budget), a display read fails open but says so (the section reads "unavailable", never empty). Two reads bypass the executor (`statSync` on share paths blocks the event loop; a direct `execFile` in `parsers/pve-storage.ts`) and move onto it; request-path work that can exceed 30 s cannot reach the browser through AnasProxy at all and should become a job (Q3). |
| Gateway and proxies | A strictly nested ladder so the layer that knows why answers: daemon command 10 s, gateway socket proxy **20 s** (new, 504 `GATEWAY_TIMEOUT` in the ANAS envelope), cross-node forward 25 s response with a separate 5 s connect, AnasProxy 30 s (unchanged). |
| `pollJob` (M5) | Retries a failed poll with backoff (1, 2, 4, 8 s, then every 10 s) and gives up after 60 s without any answer with a terminal **lost** outcome (`onLost`, else `onFailed(null)`) plus a "lost contact" alert, so a dialog disabled in `onSubmitted` is re-enabled; a 404 for the job (the daemon restarted) is lost at once. A job still running at the end of the caller's window is **never reported complete**: `pollJob` switches to a 5 s interval for as long as its view lives and calls a new `onStillRunning(job)` once (default: a toast "still running — follow it on the Dashboard"), and `onComplete` fires only on `completed`. |
| M5's other UI items | Include the replication task delete (one line: route it through `runJob`). Include the selection-by-captured-name defect as a small mechanical story with a load-sequence counter. Defer the poll-loop consolidation (7 copies) to grooming. |

---

## 1. Facts this design stands on

**F1. The queue runs 4 jobs at once, FIFO, with no notion of an object.** `new JobQueue({ audit })`
(`server.ts:123`) takes the default concurrency 4 (`jobs/queue.ts:138`); `drain` starts queued records in
insertion order until 4 run (`queue.ts:384-394`); a job holds its slot until its handler settles
(`:493-499`). Only `control: true` jobs (a cancel) bypass the limit (`:146-151`). `submit` takes no object
key (`:153-158`) [C]. A confirm code lives 2 minutes (`safety/confirm.ts:72`) and is consumed when the
route verifies it, before `submit`, so a job can run any length of time after the operator confirmed.

**F2. The only mutual exclusion today is ad hoc and in memory.** `findActive(ops, target, paramKey)`
(`queue.ts:244-265`) matches a submitter-params string; its callers are AHR only (`routes/ahr-mutate.ts:455-461`
`conflictingAhrJob`, `:825` destroy, `routes/ahr-cache.ts:84`, `index.ts:82`) and the Run-Now direct-run
lookup (`services/task-units.ts:856`) [C/R]. It is asked at request time, except by parity rewrite and
mirror reconcile, which ask again in the job. Locks that exist: `withFileLock(path)` (a per-path promise
chain, `services/file-lock.ts:15-22` [C]; its map never drops an entry), `withIscsiLock` (one chain for the
whole LIO tree, `services/iscsi-mutate.ts:161-165` [C]) and `withTopLevelMount` (a per-pool path lock for
the AHR top-level mount, `services/ahr-snapshots.ts:112-139` [R]). The AHR intent file is the one
**persisted** per-pool guard (`services/ahr-intent.ts:108-127` [R]).

**F3. Job-time re-gating exists in pieces, each written once for one verb.** `requireStableId` + the guid
readers (ident.1; `safety/stable-id.ts:320-324`, used by pool export/destroy, dataset destroy, rollback)
[C]; `recheckDestroyGates` (`routes/datasets.ts:561-578`, dataset destroy only; it throws a plain `Error`,
so the job's code is `JOB_FAILED`) [C]; `gateMutableUser`/`gateMutableGroup` (cr.3, band only,
`routes/share-identity.ts:407-417`) [R]; `assertNotForeign` (mounts, `routes/mounts.ts:164-168`) [R];
`reverifyServedLun` (`services/iscsi-served.ts:260`, LUN update/delete and image restore) [R];
`requireComposableNow` (`services/ahr-disk-recheck.ts:36`, AHR create and spare add only) [R];
`requireOwnedVgPvs`/`requirePoolVg` (cr.15/cr.22) [R]; the cr.24 reference re-read (warn only) [C];
`guardRepairPlan` (iSCSI repair re-plans under the lock, `routes/iscsi-mutate.ts:1121-1127`) [R]; parity
rewrite and mirror reconcile re-run evidence, job conflict and band refusal twice
(`services/ahr-parity-rewrite.ts:608-661`) [R]. There is no shared shape: each returns, throws or replies
differently, and the route copy and the job copy are separate code.

**F4. Re-reading is not enough for edit-shaped verbs.** The iSCSI target update diffs the desired ACL and
portal sets against the request-time target (`services/iscsi-mutate.ts:673, 695` [R]). Re-reading the
target in the job and diffing against the fresh one would silently delete an ACL another operator added
in between. The correct job-time answer is "the object is still in the state the request was computed
from, or refuse" — a revision check, not only an identity check. The same holds for `mount.update` (it
writes an entry merged from the request-time line, `routes/mounts.ts:397, 450` [R]), `fs.setAccess` (it
runs a plan computed from the request-time `getfacl`, `services/access.ts:723-760, 809-950` [R]) and every
unit-store update (schedules, replication/backup/cloud tasks), which can resurrect a task deleted after the
request (`routes/schedules.ts:401` and siblings [R]).

**F5. Reads are fast on a quiet node** [P01]: of 33 read commands the daemon runs, every median is under
60 ms except `zpool import` (device scan, 145 ms) and `zpool iostat … 1 2` (1 s by design); the slowest
single run was 185 ms. The stunt node has 6 small virtual disks and no AHR pool, so these are lower
bounds; `smartctl` on QEMU disks says nothing about a SAS disk spinning up (**[U]**, needs a capture on a
node with spinning disks; the identity probe already passes `-n standby`,
`services/disk-identity-cache.ts:376` [C], the SMART detail route does too, `routes/disks.ts:473-479` [R]).

**F6. Node's `execFile` timeout is not a deadline** [P02, Node 22.23.3 on the node and 26.11.1 locally]:
(A) a child that dies on SIGTERM ends on time; (B) a child that ignores SIGTERM keeps the callback pending
indefinitely — execFile sends one signal and waits for the exit; (C) a grandchild survives the kill,
orphaned, while the callback fires; (D) a detached child killed as a process group takes its grandchild
with it. A process in uninterruptible sleep (a `zpool` blocked in the kernel on a suspended pool, a `stat`
on a dead hard NFS mount) does not die even on SIGKILL until the kernel call returns — standard Linux
semantics, not reproduced here (**[U]** on this node: it needs a suspended pool or a dead NFS server). A
deadline therefore has to be able to give up on a child it cannot kill.

**F7. `anasd.service` uses systemd's default `KillMode=control-group`** (no `KillMode=` line in
`packaging/systemd/anasd.service`) [C], so a detached process group started by the daemon is still in the
service's cgroup and is stopped with the daemon. Detaching changes signalling, not lifetime.

**F8. The proxies' timeouts today** [C]: AnasProxy (inside pveproxy) 30 s for every request
(`packages/pve-integration/perl/AnasProxy.pm:84, 189`); a transport failure or timeout becomes a
synthetic 502. The gateway's cross-node forward 15 s (`packages/gateway/src/proxy.ts:37`), connect and
response on one timer; a connected-but-slow peer → 504 `GATEWAY_TIMEOUT`. The gateway's local socket proxy
to anasd has **no** timeout (`proxy.ts:136-153`), so a hung daemon read leaves the gateway request open
after pveproxy has already answered the browser 502.

**F9. `pollJob` today** [C, `packages/pve-integration/src/10-api.js:235-292`]: polls every 500 ms; on a
failed GET it logs `job poll failed` and stops (`:286-289`) — neither `onComplete` nor `onFailed` fires;
at the end of the window (`maxMs`, default 15 s, `:237`) a job still running is handed to `onComplete(job)`
(`:278-284`) without a success toast, so callers treat "still running" as "done". Window overrides: 30 s
(pool destroy, dataset destroy and rollback, a share), 45 s (cancel run), 120 s (scrubs), 600 s (backup and
cloud Run Now), 3 600 s (restores). Every AHR verb (expand, replace, readd, spare, cache, remount) uses the
15 s default although several run for hours (§2.3). The cancel-run flow (`69-schedules-common.js:225-243`)
toasts "Run cancelled" from `onComplete`, so a cancel still in progress at 45 s is announced as done.

---

## 2. Inventory: every state-changing verb, its gates, and what the job re-runs today (H8)

Legend: **RT** = request-time gate; **Job** = what the job body re-checks before acting; **Missing** =
gates that exist at RT and are not re-run (the H8 gap); **Cap** = the job acts on a value captured at
request time. A verb with "—" under Missing is already closed. Line numbers at `fc596e1`; rows I did not
re-read myself are [R].

### 2.1 ZFS (`routes/pools.ts`, `routes/datasets.ts`, `routes/scrub.ts`)

| Verb → op | Confirm (bound / stable id) | RT gates | Job re-runs | Missing |
|---|---|---|---|---|
| pool scrub / trim → `zpool.scrub`, `zpool.trim` (`pools.ts:1020, 1068`) | none | exists | nothing | existence (harmless: zpool fails) |
| pool upgrade → `zpool.upgrade` (`:1115`) | `{pool}`, **no guid** | exists | nothing | identity; no system/PVE gate exists at all |
| pool props → `zpool.set` (`:1170`) | none | allow-list, exists | nothing | — (no system/PVE gate exists) |
| pool mountpoint → `zpool.mountpoint` (`:1242`) | `{pool, mountpoint}`, **no guid** | exists, system pool, PVE storage, reserved path, live-mount/fstab/other-pool collisions (`:1260-1315`) | nothing | **all**, identity |
| pool create → `zpool.create` (`:1363`) | only with `force`: `{pool}`; disks and vdevs unbound | redundancy, name collision, mountpoint, **disk composability** (`:1435-1444`, fail closed since cr.12) | nothing | **disk eligibility**, name collision, mountpoint |
| pool import → `zpool.import` (`:1498`) | only with `force`: `{target}`; `altroot` unbound | schema | nothing | — |
| add vdev → `zpool.add` (`:1594`) | **none** (review M2: irreversible) | redundancy, exists, `vdevTopologyGate` (system pool + PVE), composability | nothing | **all** |
| remove vdev → `zpool.remove` (`:1701`) | none | exists, `vdevTopologyGate`, status read, vdev resolved to a token | nothing; uses the RT token (`:1761, 1784`) | all; the token is not re-resolved (Cap) |
| raidz expand → `zpool.raidz-expand` (`:1897`) | **none** (M2) | exists, composability, raidz data vdev, version, feature flag, busy | nothing | **all**; no `vdevTopologyGate` at either time |
| attach / replace → `zpool.attach`, `zpool.replace` (`:1966-2025`) | none | exists, composability, busy (attach only), leaf resolved | nothing | **all**; no `vdevTopologyGate`; leaf not re-resolved |
| pool export → `zpool.export` (`:2049`) | `{pool}` + guid; **`force` unbound, uncommented** | exists, **system pool**, **LUN-held**, references (warn) | guid (`requireStableId`, `:2149`) [C], references re-read (warn) | **system pool, LUN-held** |
| pool destroy → `zpool.destroy` (`:2193`) | `{pool}` + guid; **`cleanup` unbound** (`:2261-2264`) [C] | exists, **system pool**, **LUN-held**, references (warn) | guid (`:2289`) [C], references (warn), per-leaf label guid before the wipe | **system pool, LUN-held** |
| dataset create → `zfs.create` (`datasets.ts:893`) | none | pool exists, exists, PVE naming, ownership | nothing | ownership, collision |
| snapshot create → `zfs.snapshot` (`:1527`) | none | exists, ownership, recursive owned-descendant, collision | nothing | ownership, descendants |
| rollback → `zfs.rollback` (`:1705`) | `{snapshot}` + `{snapshotTxg, newestTxg}`; **`force` (-r) unbound** (`:1716-1718`) | exists, ownership, **LUN-held** (volume and filesystem) | ids (`:1804`) | **ownership, LUN-held** |
| clone → `zfs.clone` (`:1816`) | none | source exists/ownership, target collision/naming/ownership | nothing | all |
| set properties → `zfs.set` (`:1049`) | none | exists, ownership, prop kind, shrink/LUN, served device | `reverifyServedLun` for a served-zvol grow only (`:1190-1196`) | ownership, shrink gate |
| snapshot rename → `zfs.rename` (`:1605`) | none | exists, ownership | nothing | ownership |
| set access → `fs.setAccess` (`:1221`) | only recursive: `{dataset}` (`services/access.ts:613-618`); owner, group, mode, entries unbound | ownership, recursive refusal, plan from live `getfacl` | nothing | **all**; the plan is Cap (F4) |
| dataset destroy → `zfs.destroy` (`:1290`) | `{dataset}` + guid; **`recursive` unbound** (`:1428-1431`) [C] | exists, ownership, owned descendants, LUN-held | guid + `recheckDestroyGates` (`:1461-1462`) [C] | — for gates; **the child set is not bound** (children created after the challenge are swept) |
| snapshot destroy → `zfs.destroy` (`:1659`, same op name) | none, by design | exists, ownership | nothing | ownership |
| ZFS scrub toggle → `scrub.zfs.toggle` (`scrub.ts:140`) | none | exists | nothing | — |

Not in H8 but found: **pool export and destroy have no PVE-ownership gate** (`ownershipOf` is called in
pools.ts only by `poolStamp`, `:584`, and `vdevTopologyGate`, `:810`), although the `vdevTopologyGate`
comment (`:793-797`) says they "stand behind" it; the panel greys the buttons. **[U]** whether intended.
The guard spec for both verbs includes the PVE gate (a whole PVE pool is `storage.cfg` territory, §2 "PVE
territory is read-only and hands-off").

### 2.2 H8 items, verified

| Review H8 item | Verdict at `fc596e1` |
|---|---|
| ZFS create/add/attach: disk eligibility only at request | **STILL TRUE** (cr.12 made it fail closed, at request time only) |
| attach/replace/raidz-expand skip `vdevTopologyGate` | **STILL TRUE** |
| Pool destroy/export and rollback: LUN-held and system-pool not re-run | **STILL TRUE** (ident.1 added the guid, cr.24 the warn-only references; the gates themselves are not re-run). Rollback does not re-run ownership either |
| Dataset destroy re-runs its gates | **CONFIRMED** (`recheckDestroyGates`) |
| `zfs destroy -r` sweeps children created after the challenge | **STILL TRUE** |
| Upgrade and mountpoint confirms are name-only | **STILL TRUE** |
| AHR expand/replace/cache attach: no job-time `requireComposableNow` | **STILL TRUE** (create and spare add have it) |
| Cache attach has no confirm; `sgdisk -n` over any whole-disk signature | **PARTLY**: it now refuses a disk with partition-table entries (`services/ahr-cache.ts:389-394`); a raw disk carrying a whole-disk signature (LVM PV, filesystem, bluestore) is still partitioned, and there is still no confirm |
| AHR destroy refuses in-flight `ahr.*` jobs at request time only | **STILL TRUE**. cr.31 moved every service-level read and `requireOwnedVgPvs` before the first act, and the job re-checks the array UUIDs and the references, but not the in-flight check, the running intent, the system pool or LUN-held |
| AHR destroy/mountpoint/remount LUN-held request-time only | **STILL TRUE**; AHR snapshot rollback the same; the system-pool check (cr.23) is also request-time only, and absent on AHR mountpoint and rollback |
| iSCSI `reverifyServedLun` never compares sessions | **STILL TRUE** |
| LUN delete / file resize session gates request-time only | **STILL TRUE** |
| Target update/state/delete act on the request-time target | **STILL TRUE**. "A queued update drops ACLs added since" is **PARTLY** right: an ACL added since survives; one removed since makes `targetcli delete` fail mid-sequence with no `saveconfig`; a new ACL is granted only the request-time LUNs (F4) |
| Target delete can drop a LUN added since | **STILL TRUE** (and sessions that logged in since) |
| Add-LUN index from the request-time target (audit #34) | **STILL TRUE, and wider**: the backup new-LUN restore uses the same stale target (`services/backup-restore.ts:932`) [R] |
| Schedule fire uses the schedule read by the route | **STILL TRUE** (PVE ownership is re-checked in the job, the schedule itself is not) [C `routes/schedules.ts:457, 476`] |
| No per-object mutex for ZFS; none per AHR pool across verbs | **STILL TRUE** |

### 2.3 AHR (`routes/ahr-*.ts`)

Status 2026-10-15: the Missing cells of this table are closed by cr.38 sessions A and B (the access row by cr.37); the table is the pre-implementation snapshot.

| Verb → op | Confirm | RT gates | Job re-runs | Missing | Runs for |
|---|---|---|---|---|---|
| create → `ahr.create` (`ahr-mutate.ts:475`) | `{name}` only; **disks, tier, mountpoint unbound** | name/VG free, `ahrNameOccupancy`, mountpoint, composability, layout | `ahrNameOccupancy`, `requireComposableNow`, re-plan | mountpoint (an fstab clash throws after the wipe, then the rollback runs) | minutes (resync not awaited) |
| mountpoint → `ahr.mountpoint` (`:629`) | `{name, mountpoint}` | exists, reserved, target free, **LUN-held**; no system-pool gate | nothing | all | seconds |
| remount → `ahr.remount` (`:733`) | `{name}` | read-only state, cache, **system pool**, **LUN-held** | post-hoc read-only check | all | seconds |
| destroy → `ahr.destroy` (`:806`) | `{name, arrays: uuids}` (in params, so a change gives a plain fresh 409, not `IDENTITY_MISMATCH`) | **in-flight `ahr.*`**, **running intent**, **system pool**, **LUN-held**, references (warn) | UUIDs, references, `requireOwnedVgPvs` and every read before the first act (cr.31) | in-flight, intent, system pool, LUN-held | seconds |
| scrub → `ahr.scrub` (`:953`) | none | state, mounted, job conflict, node-wide `runningAhrCheck` | per band: `sync_action` idle or skip | job conflict, `runningAhrCheck` | hours (polls md and btrfs) |
| repair → `ahr.repair` (`:1034`) | `{name, files}` | mounted, state, job conflict, running check, top-level mount, path confinement, LUN session | engine per-block gate + `preWriteRefusal` | job conflict, running check, confinement, LUN session | minutes per block |
| parity rewrite / mirror reconcile (`:1209`, `:1357`) | `{name, band}` (band number, not its UUID) | evidence, state, job conflict, running check, band refusal | **twice**: evidence, job conflict, band refusal, `preWriteRefusal` (the model to copy) | running check, state roll-up | hours |
| expand → `ahr.expand` (`ahr-expand.ts:276`) | `{pool, addDisks, replace}` | degraded refusal, existing intent, member/availability, planner | intent `expect: 'absent'`; partition-number collision | **composability**, degraded, identity; `submitExpansion` closes over the RT pool (`services/ahr-expand-resume.ts:263-271`) | hours to days (`waitForArrayIdle` polls mdstat every 3 s) |
| resume / abandon (`:343`, `:406`) | `{pool, intent, approvedDisks}` / `{pool, intent}` | halted intent, `halfJoinedProblem` / intent not running | resume: as expand; abandon: nothing (`clearIntent` checks neither id nor state) | abandon: intent id and state | as expand |
| replace → `ahr.replace` (`:448`) | `{pool, oldDiskId, newDiskId}` | intent, membership, new disk available | intent, partition collision, per-band swap detection | **composability of the new disk** | hours |
| readd → `ahr.readd` (`:522`) | `{pool, diskId}` | intent, no reshape | slice superblock UUID = band UUID | intent | minutes to hours |
| spare add / remove (`ahr-spare.ts:73`, `:160`) | `{pool, diskId}` | intent, composability, coverage / is a spare | coverage, `requireComposableNow`, bands assembled / active-member check twice | intent | seconds |
| cache attach → `ahr.cache.attach` (`ahr-cache.ts:115`) | **none** | intent, cache job in flight, state, disk available | already attached, partition refusal | **eligibility, `requirePoolVg` before `vgextend`**, intent, state | seconds |
| cache detach / event (`:215`, `:295`) | none | intent, cache job in flight, presence | slice ownership, `requirePoolVg` | intent | seconds |
| snapshot create / delete / rollback (`ahr-snapshots.ts:143, 176, 215`) | none / `{pool, snap}` / `{pool, snap}` | layout, intent, state, name; rollback **LUN-held**, no system-pool gate | path lock only | all; rollback's unmount uses the RT `mounted` outside the lock | seconds |
| access → `fs.setAccess` (`ahr-access.ts:89`) | recursive only: `{pool}` | mounted, path guards, plan | acl tool present | all (the plan is Cap) | tree-sized |

The AHR de-facto mutex is three sets keyed by pool **name** (`REPAIR_EXCLUSIVE` `ahr-mutate.ts:182`,
`AHR_JOB_OPERATIONS` `:363-384` used by destroy only, `CACHE_EXCLUSIVE` `ahr-cache.ts:23`) plus the intent
file. Verbs that consult no job at all: mountpoint, remount, expand, resume, abandon, replace, readd, spare
add/remove, the snapshot verbs, access. Not seen by destroy's check: `fs.setAccess`, `schedule.run`,
`backup.task.run` and cloud runs (which create and delete AHR snapshots), `scrub.ahr.toggle`. The boot
cache rung calls `recoverFailedAhrCache` outside the queue (`services/ahr-boot-scan.ts:295`) [R]. Between
daemon start and the end of the boot scan the socket already serves (`index.ts:67-79`) and only the intent
file protects a pool [R].

### 2.4 iSCSI, schedules, replication, backup, cloud

| Verb → op | Confirm | RT gates | Job re-runs | Missing / Cap |
|---|---|---|---|---|
| target create (`iscsi-mutate.ts:248`) | none | preflight, exists, zero-ACL | nothing | Cap `req` |
| target update (`:314`) | only when a live ACL/portal is removed: `{target}`; the removed set unbound | preflight, foreign, CHAP merge, sessions/portals | nothing | **revision** (F4); sessions |
| target enable/disable (`:465`) | none | preflight, foreign, already in state | nothing | Cap target |
| target delete (`:516`) | none (ruling: refuse, never confirm) | **live sessions 409**, **has LUNs 409** | nothing | **sessions, LUN count** |
| LUN add (`:583`) | none | preflight, foreign, name taken, backing resolve/ownership/already mapped | nothing | **index and ACL grants from the RT target** (audit #34); backing |
| LUN update (`:698`) | none (shrink is a hard 409) | served device, size, shrink, **sessions** | `reverifyServedLun` + size/shrink | **sessions** |
| LUN delete (`:926`) | `{target, serial, backstore}`; **`destroyBacking` unbound** (deliberate, `:1007-1013`) | **sessions**, served device, zvol snapshots when destroying the backing | `reverifyServedLun` | **sessions**, snapshot check |
| health repair (`:1083`) | none | plan guard | fresh state + `guardRepairPlan` under the lock | — (the model) |
| schedule create / update / delete (`schedules.ts:283, 334, 412`) | none | exists, `guardTarget` | nothing | update can **resurrect** a deleted schedule; delete ignores a running fire |
| schedule run (`:445`) | none | read the schedule | PVE ownership + descendants, AHR pool | **the schedule itself** (Cap, `:457, 476`) [C] |
| replicate (`replication.ts:264`) | none (`recv -F` never used) | source exists, ownership, `guardReplicationTarget` | snapshots relisted, divergence, source ownership (snapshotFirst only) | target guard; **remote location Cap**; no exclusion between two runs of one source |
| replication / backup / cloud task create, update, delete | none (replication's `?retarget=true` is a flag, not a code) | exists, guards | nothing | creates race; an update resurrects; **delete ignores an active run** (audit #39) |
| replication remote update / delete (`replication-remotes.ts:123, 169`) | none | CAS; delete refuses referencing tasks | CAS under the lock | the reference check is not re-run; update re-points with no confirm |
| backup repo create / update / delete (`backup.ts:348, 395, 471`) | none | CAS; delete IN_USE | CAS | the secret is written **before** the CAS can fail; IN_USE not re-run |
| backup / cloud task run (`backup.ts:1200`, `cloud.ts:928`) | none | exists, run active (non-direct) | the direct run re-reads task, repo, source guard | — for direct runs |
| image restore in place (`backup.ts:1643`) | `{target, serial, repo, snapshot, archive}` | served device, size, **sessions** | `reverifyServedLun` + size + sessions under the lock | **`target.enabled` comes from the RT object** and decides whether the target is disabled for the stream (`services/backup-restore.ts:639`) [C] |
| image restore as a new LUN | `{target, lun, mode}`; snapshot, archive, backing unbound | target, name, backing | nothing | stale index and ACLs (audit #34) |
| file restore | `{target, snapshot, archive, mode}`; **selections unbound** | PVE territory, LUN-held, writable, space | nothing | everything |
| cloud remote update / delete (`cloud.ts:390, 485`) | retarget: `{remote, changes}` | encrypted, exists, references | existence/type under the lock | the retarget decision and references are not re-run |

### 2.5 Mounts, shares, identity

| Verb → op | Confirm | RT gates | Job re-runs | Missing / Cap |
|---|---|---|---|---|
| mount create (`mounts.ts:312`) | only for a non-empty dir: `{mountpoint}` | PVE, system path, PVE storage, ZFS mountpoint, already in fstab | "in fstab" under the lock, **persistent only** | the non-persistent create (the exact case the gate exists for, `:272-275`) |
| mount update (`:412`) | none | PVE, AHR, line exists, remote, foreign | foreign, line exists | **revision**: it writes the entry merged from the RT line (Cap) |
| mount / enable / unmount / disable (`:522-615`) | busy only: `{mountpoint}` | PVE, AHR, remote, foreign, **LUN-held** | foreign | **LUN-held** (a hard refusal), state |
| mount remove (`:686`) | **busy only**: a remove with no holders has no confirm; the credentials file and the `rmdir` are unbound | as unmount | foreign, cred-file reference, `isMounted` before `rmdir` | LUN-held, holders |
| SMB add/update/remove, NFS add/update/remove (`shares-smb.ts`, `shares-nfs.ts`) | delete: `{share}` / `{path}`; a recursive grant: `{path}` | exists, owned path, self-service | edits under `editConfig` with a sha re-check; self-service, testparm | **existence**: update/remove report success for a vanished share; add can write a duplicate stanza; NFS `exportfs -ra` runs outside the lock |
| share / NFS access (`share-access.ts:34`) | recursive only: `{path}` | path, guards, plan | nothing | all (the plan is Cap) |
| user add / password / enable / disable / delete; group add / members / delete (`share-identity.ts`) | delete: `{name}`; uid/gid only in the warnings | exists, local, **band**, share references (hard 409), primary-group use | band only (`gateMutableUser`) | **uid/gid equality** (the job uses the RT uid, `:939`), share references, primary group |
| job cancel (`jobs.ts:150`) | `{id}` | `cancelTarget` | `cancelTarget` again | — |

**Discrepancy with EPICS §2 (Mounts):** the ruling says "unmount cross-checks shares and backup tasks
riding the path", and `routes/mounts.ts:107-108` calls the LUN check "the mount-side twin of the
shares/backup-task cross-check the verb ladder already does". No such cross-check exists: `routes/mounts.ts`
reads no share, export or backup task, and `readPoolReferences` is imported only by `routes/pools.ts` and
`routes/ahr-mutate.ts` [C, grep]. The cr.24 helper answers "what references this path"; proposed as cr.39.

---

## 3. The one helper: `safety/guard.ts` (H8, ruling (j))

### 3.1 Alternatives

| | Shape | For | Against |
|---|---|---|---|
| A | Keep per-verb re-checks (extend `recheckDestroyGates`, `gateMutableUser`, … verb by verb) | No new abstraction; each fix is local | It is how we got here: the route copy and the job copy drift (rollback re-runs the id but not ownership; destroy re-runs references but not LUN-held). Ruling (j) names "the one helper" |
| B | A generic "re-run the route" in the job: replay the request handler in a dry-run mode | One mechanism for everything | Route handlers reply, mint confirm codes and submit jobs; a dry-run flag through 160 handlers is invasive and easy to get wrong silently |
| **C** | **A guard spec per verb: object view (read, id, revision, scope), lock claims, gate list. The route and the job both run it; the gates are plain functions returning a refusal** | The gates exist once; the job cannot skip one the route runs; refusals carry their HTTP status and error code for both doors; identity and revision checks become uniform | Every verb's gates have to be lifted into functions (the bulk of the work, done area by area) |

**Recommendation: C.** It is the shape parity rewrite and mirror reconcile already approximate by hand
(they re-run evidence, job conflict and band refusal in the job, twice) and the shape iSCSI repair uses
(re-plan under the lock and re-guard the fresh plan).

### 3.2 Shape

```ts
// packages/daemon/src/safety/guard.ts — sketch, not final names

/** What a gate answers when it refuses. The same object becomes the 4xx at the route and the job's error. */
export interface Refusal {
  status: 400 | 403 | 404 | 409 | 503
  code: ErrorCode                // PROTECTED_RESOURCE, IN_USE, CONFLICT, PVE_MANAGED, IDENTITY_MISMATCH,
                                 // STATE_CHANGED (new), UNAVAILABLE, TIMEOUT (new) …
  message: string                // the sentence the operator reads; names the object
  reason?: string
}
/** A gate reads what it needs (through the object or its own reads) and refuses or passes. Fail closed:
 *  a fact it cannot read is a refusal (`UNAVAILABLE`), never a pass. */
export type Gate<O> = (object: O) => Promise<Refusal | null>

export interface ObjectView<O> {
  what: string                              // "Pool 'tank'"
  read: () => Promise<O | null>             // null = gone
  id: (o: O) => BoundId                     // same object? (pool/dataset guid, VG UUID, LUN serial, uid …)
  revision?: (o: O) => string               // same state? sha256 of the facts the request was computed from
  scope?: (o: O) => BoundId                 // blast radius: sorted child guids, wiped disk ids … (bound, §5)
}

export interface GuardSpec<O> {
  operation: string                         // job op name, also the confirm operation
  object: ObjectView<O>
  locks: (o: O) => LockClaim[]              // §4; computed from what was read, so keys are stable ids
  gates: Gate<O>[]                          // every gate, in order; the SAME list at both doors
  advisories?: (o: O) => Promise<Advisory[]>  // warn-only facts (cr.24 references); never refuse
}

// Route door
const pre = await guardCheck(spec)                     // read → gates → { object, bound } | { refusal }
if ('refusal' in pre) return sendRefusal(reply, pre.refusal)
if (!guardConfirm(confirmStore, request, reply, spec, pre, { params: validatedRequest, message, warnings }))
  return reply                                         // §5: binds params + id + revision + scope
jobQueue.submit(spec.operation, submitter, guarded(spec, pre, body), { locks: spec.locks(pre.object) })

// Job door: `guarded` runs when the queue has granted the locks
//  1. object = read()            → null: IDENTITY_MISMATCH ("… is gone")
//  2. id(object) ≠ pre.bound.id  → IDENTITY_MISMATCH (today's sentence, identityMismatchMessage)
//  3. revision ≠ pre's           → STATE_CHANGED ("… changed since you opened it; nothing was done; reload")
//  4. scope ≠ pre's              → STATE_CHANGED naming what appeared/disappeared (e.g. a new child dataset)
//  5. each gate                  → the first refusal fails the job with refusal.code and refusal.message
//  6. advisories diffed against the confirmed set → new ones go into the result's warnings (cr.24 today)
//  7. body(object, progress, ctx)
```

Rules that come with it:

- **A gate is a function of facts read now.** It may take a `ReadCache` (the dashboard's and the iSCSI
  claims cache's idiom) so the route's several gates share one `zpool status`, but nothing read at the
  request may be passed to the job's gate run. `guarded` creates a fresh cache.
- **Refusal codes are the existing ones** (`shared/schemas/api.ts:13-60`) plus two: `STATE_CHANGED` (409:
  the object is the same one but its state is not the one the request was computed from) and `TIMEOUT`
  (503: a read the gate needed did not answer within its deadline, §6). The job carries `refusal.code` as
  its `error.code` through the existing `jobErrorCode` seam (`jobs/queue.ts:476-480`), so the UI reads a
  job refusal like the 409 it would have got.
- **Long jobs re-guard per act step.** A job that runs for hours (AHR expand/replace/readd, scrub, repair,
  parity rewrite, replication, backup, restores, recursive ACL apply) calls `ctx.reguard()` before each
  step that changes the object: it re-acquires its locks (§4.4), re-reads, re-compares the id, re-runs the
  gates. Parity rewrite's "evidence, conflict, band refusal, `preWriteRefusal` right before the write" is
  this pattern; it becomes the helper's call.
- **The route may keep extra request-only checks** that are about the request, not the object (schema
  validation, "the name you typed is reserved"). Anything about the object's state is a gate.
- **Warn-only stays warn-only.** cr.24's references and the "LIO configuration was unreadable" disclosure
  are advisories: listed in the confirm, re-read in the job, new ones reported, never a refusal (§2
  "state the failure mode once").

### 3.3 Object identity per family

| Family | id (same object?) | revision (same state?) — edit-shaped verbs only | scope (bound blast radius) |
|---|---|---|---|
| ZFS pool | `zpool get guid` (exists, `readPoolGuid`) | — | destroy+cleanup: sorted by-id of the leaves to wipe |
| ZFS dataset | `zfs get guid` (exists) | `fs.setAccess`: sha256 of the `getfacl` text + owner/mode the plan was computed from | recursive destroy: sorted guids of every descendant (`zfs list -r -H -o guid`) |
| ZFS snapshot | `{snapshotTxg, newestTxg}` (exists) | — | rollback -r: covered by `newestTxg` |
| AHR pool | **VG UUID** (`vgs -o vg_uuid`), plus the band array UUIDs destroy already binds | — | create: sorted disk ids; spare/cache/replace: the disk id |
| AHR band | the band's md array UUID (today: band number) | — | — |
| AHR snapshot | btrfs subvolume UUID (`btrfs subvolume show`, already called by the daemon) **[U]** whether it is read today for snapshots | — | — |
| iSCSI target | IQN (an IQN is its identity) | update/state/delete: sha256 of the sorted ACL, portal and LUN lists (+ enabled) | — |
| iSCSI LUN | `ServedLunIdentity` (serial, backstore, path, device; exists) | — | delete+destroyBacking: the backing zvol guid / file inode |
| Mount | the fstab line's spec+type (what `assertNotForeign` compares) | update: sha256 of the fstab line | remove: credentials file + `removeMountpointDir` flag |
| SMB / NFS share | section name / export path | update: sha256 of the stanza / export line | — |
| User / group | **uid / gid** (today: name; the job uses the request-time uid, `share-identity.ts:939`) | — | — |
| Unit-store task / schedule | id; the unit's `x-anas` JSON | update: sha256 of the unit JSON (a deleted task reads `null` → gone) | — |
| Disk (create/add/attach/spare/cache) | the inventory's whole-disk by-id | — | — |

---

## 4. Per-object locks

### 4.1 Where the lock lives: the queue

| | Option | Verdict |
|---|---|---|
| a | A mutex taken inside the job body (`withFileLock(key, …)`) | A job waiting on it **holds one of the 4 slots** while waiting; four jobs queued on one busy pool stall the daemon. Rejected |
| b | A request-time refusal when a conflicting job is in flight (`findActive`, today's AHR) | Says "busy, try later" for work the operator already confirmed; still races between the check and the job. Kept as an *advisory* only (the confirm can say "this will wait behind job X") |
| **c** | **Lock claims on `submit`; `drain` starts a job only when all its claims can be granted** | No slot is spent waiting; the order is FIFO; the gate run happens after the grant, so whatever ran first is seen. **Recommended** |

`submit(operation, submitter, handler, { locks })` stores the claims. `drain` walks queued records in
order and starts each whose claims are all grantable **and** whose keys have no earlier queued claim that
conflicts (per-key FIFO: a queued exclusive claim blocks later shared ones, so a destroy is not starved by
a stream of snapshot jobs). Grants are all-or-nothing, so no job ever waits while holding a key: no
deadlock. A blocked job stays `queued`; its `progress` reads "waiting for <operation> (job <id>) on
<what>", which the jobs strip already shows. Release happens in `execute`'s `finally`, after the status is
settled, then `drain` runs again (it already does, `queue.ts:493-499`). Control jobs (cancel) take no
locks.

### 4.2 Keys and modes

Keys are stable ids, so a rename or a namesake cannot alias two objects, plus a **name key** for every
verb that changes a namespace, so an export of `tank` and an import of another pool called `tank`
serialise even though they have different guids.

| Key | Taken by | Mode |
|---|---|---|
| `zpool:<guid>` | every ZFS verb on the pool or anything in it | X for pool-structural verbs (destroy, export, upgrade, mountpoint, add/remove vdev, attach, replace, raidz expand, cleanup); S for everything inside the pool |
| `zfs:<poolGuid>/<dataset path>` (+ every ancestor's key in S) | dataset and snapshot verbs, replication source/target, backup and cloud runs on a path in the pool, schedule fire | X: dataset destroy, rollback, snapshot rename (F2: a running send does not stop a rename — row 6 c3), set properties, set access, clone target; S: snapshot create, snapshot destroy (cr.47c — a recursive destroy is atomic row 6 c1/c4, and ZFS's own "dataset is busy" protects the snapshot a send reads, row 6 c5), replicate source, backup/cloud source, schedule fire |
| `zname:<pool name>`, `ahrname:<name>` | create, import, export, destroy (both families) | X |
| `ahr:<vg uuid>` | every AHR verb | X for destroy, mountpoint, remount, expand step, replace step, readd step, cache attach/detach, spare add/remove, snapshot rollback; S for scrub, repair block, snapshot create/delete, access, runs reading it |
| `disk:<inventory by-id>` | every verb that writes a disk: ZFS create/add/attach/replace/cleanup, AHR create/expand/replace/spare/cache | X |
| `iscsi-target:<iqn>`, `iscsi-lun:<serial>` | target and LUN verbs, image restore | X (the existing `withIscsiLock` stays inside for the `targetcli` section) |
| `mount:<target path>` | mount verbs | X |
| `share:smb:<section, case-folded>`, `share:nfs:<path>` | share verbs | X |
| `uid:<n>`, `gid:<n>`, `idname:<name>` | identity verbs (`idname` for create) | X |
| `task:<kind>:<name>`, `schedule:<id>` | task/schedule create, update, delete (X); the DIRECT run (S); the Run-Now supervisor takes NO key (cr.41, cr.33b constraint: only one of the supervisor/direct pair may hold it or a queued delete deadlocks them under per-key FIFO; cr.49's watch lane refuses locks outright) | as stated |

A pool whose key cannot be read (VG unreadable, `zpool get guid` fails) is locked by its name key only, in
X — the conservative fallback, and its gates will refuse anyway when they cannot read their facts. So that
the fallback meets the verbs that did read the key (cr.33b), every guid- or VG-UUID-keyed claim set also
carries the pool's name key (`zname:`/`ahrname:`) in S — X for the namespace verbs, as in the table.

### 4.3 Long jobs and the 4 slots

A job holds its locks only while ANAS itself is changing the object. Kernel-driven background work
(resilver, ZFS scrub, md resync/reshape/check, btrfs scrub) is state, which the gates read (busy, degraded,
`sync_action`, the AHR intent file), not a lock. So:

- a long job calls `ctx.release()` before a wait (`waitForArrayIdle`, `waitForReplaceDone`, a scrub poll)
  and `ctx.reguard()` (re-acquire, re-read, re-gate) before its next act step; the AHR intent file keeps
  its role as the persisted "an expansion owns this pool" claim that other verbs' gates refuse on;
- data movers (replication, backup, cloud, restores) hold shared claims on their source for the run,
  which only exclude a destroy, rollback or rename of that dataset — the operator gets "waiting for
  zfs.replicate (job …)" instead of a send that dies mid-stream.

Locks do not fix a different starvation: four long data movers fill all 4 slots and a short destroy waits
for a slot, not for a lock (Run Now holds two: the supervisor and the direct run, `queue.ts:147-151`). **Recommendation:** a
job declares a lane (`'long'` for the data movers, the AHR long verbs and the supervisors), and `drain`
starts a long job only while fewer than 3 slots hold long jobs, so one slot is always free for short
verbs. This is a two-line change in `drain` and is in cr.33. (Superseded for the supervisors by cr.49, ruled
2026-10-15: they ride a `watch` lane with slots of their own beyond the 4 — see DESIGN.md "Per-object locks and the
long lane".)

### 4.4 Failure modes of the lock

| Mode | Handling |
|---|---|
| A handler throws | release in `execute`'s `finally` (the status is settled first) |
| A child is abandoned (§6.4) | the job ends `failed`, but its claims stay **held** until the abandoned child really exits (the executor resolves an `abandoned` promise when it does); the job record carries `holdsLocks: true` and the waiting jobs' progress names it. A command we could not stop is still changing the object |
| Daemon restart | locks and queued jobs vanish together (in memory, Principle 11); kernel state is the truth; the AHR intent file still marks an expansion. The boot scan's resume is submitted through the queue with its claims like any job |
| Work outside the queue | the boot cache rung (`ahr-boot-scan.ts:295`) and the udev cache event must submit jobs with claims, never act inline (cr.36) |
| Two jobs wanting each other's keys | impossible: grants are all-or-nothing and a re-acquire releases everything first |

---

## 5. Confirm codes that bind the blast radius (M3)

### 5.1 What is unbound today

| Confirm | Bound today | Changes what is destroyed, unbound |
|---|---|---|
| ZFS pool destroy | `{pool}` + guid | `cleanup` (and the disks it wipes) |
| ZFS pool export | `{pool}` + guid | `force` (the UI never sends it, `36-pool-export.js:30-35` [R]) |
| ZFS dataset destroy | `{dataset}` + guid | `recursive`, and the set of children it sweeps |
| ZFS rollback | `{snapshot}` + txgs | `force` (-r); later snapshots are covered by `newestTxg` |
| ZFS create with `force` (cr.12) | `{pool}` | the disks, the vdev layout, the mountpoint |
| ZFS import with `force` (cr.12) | `{target}` | `altroot` |
| ZFS upgrade, mountpoint | name only | the guid |
| Set access, recursive (ZFS, AHR, shares) | `{dataset}` / `{pool}` / `{path}` | owner, group, mode, entries, `clearNamed`, and the ACL state the plan was computed from |
| AHR create | `{name}` | `disks`, `tier`, `mountpoint` — the disks it wipes |
| AHR parity rewrite / mirror reconcile | `{name, band}` | the band's array UUID |
| AHR snapshot delete / rollback | `{pool, snap}` | the subvolume's UUID |
| iSCSI target update | `{target}` | the ACLs and portals it removes |
| iSCSI LUN delete | `{target, serial, backstore}` | `destroyBacking` (deliberate today, `iscsi-mutate.ts:1007-1013`) |
| Image restore as a new LUN | `{target, lun, mode}` | snapshot, archive, backing |
| File restore | `{target, snapshot, archive, mode}` | the selections |
| Mount unmount/disable/remove (busy) | `{mountpoint}` | `removeMountpointDir`; a remove with no holders has no confirm at all |
| User / group delete | `{name}` | the uid / gid |
| SMB interface binding | `{section: 'global'}` | the values (deliberate, `shares-smb.ts:368-369`) |

The reason every exclusion gives is the same (`pools.ts:2261-2264`, `datasets.ts:1428-1431`): "the checkbox
is chosen after the challenge is issued, so binding it would make the confirmed request mismatch the code".
That is a UI constraint, solved in §5.3, not a reason to leave the flag out.

### 5.2 The rule

1. **Bind by default.** `guardConfirm` signs the operation plus the whole validated request: path params,
   the Zod-parsed body (defaults applied, so an omitted flag and an explicit `false` sign the same) and
   query flags. A field may be left out only by naming it in `presentationOnly` with a one-line reason
   (none in the inventory qualifies today except the SMB binding values, where the confirm is about live
   connections, not the values). A unit test lists every `presentationOnly` entry per route, so adding
   one is a visible diff.
2. **Bind the derived set, not only the flag.** `scope` (§3.3) goes into the bound id: a recursive destroy
   binds the sorted descendant guids, so a child created after the challenge makes the resend answer 409
   and the job (if the child appears while it waits) fail `STATE_CHANGED`. The warnings list the same set,
   so what is bound is what was shown.
3. **A resend that differs gets a fresh 409 that says what changed.** Today a code minted for other params
   simply fails `verifyCode` and the gate mints a new one with the generic `CONFIRMATION_REQUIRED`
   (`safety/gate.ts:176-191`). `ConfirmStore` learns `explainMismatch(code, operation)` returning the keys
   whose values differ, and the gate answers `CONFIRM_SCOPE_CHANGED` (new code; 409; a fresh code;
   message "You confirmed with cleanup off; this request has cleanup on — confirm again"), the code
   consumed. `IDENTITY_MISMATCH` stays for a different object. The UI's `REPROMPT_CODES`
   (`10-api.js:402`) gains the new code.

### 5.3 The UI side

The review is right that the operator never sees "The pool's disks will be wiped clean" (`pools.ts:2243-2244`
emits it only when the first request already carries `cleanup`; `37-pool-destroy.js:57-59` appends it only
to the confirmed resend [C]). The same pattern exists for `?recursive=true` (`60-datasets.js:2655-2657`)
and `?force=true` on rollback (`60-datasets.js:2972-2974`) [C].

| | Option | Verdict |
|---|---|---|
| a | A separate options dialog before the first request ("Destroy pool… [ ] clean up disks → Continue"), then the confirm | Correct, but two modal steps for every destroy |
| **b** | **Re-challenge in place**: the first request sends every bound option explicitly with its default (`?cleanup=false`); the confirm window keeps the checkbox; changing a bound option disables OK, re-sends the **unconfirmed** request with the new value, and replaces the warnings and the code in the same window | One dialog; the wipe warning appears the moment the box is ticked; the code always matches what is shown. **Recommended** |
| c | Mint one code per option combination | Leaks the option space into the store; rejected |

Option (b) is safe only for a verb whose daemon confirm is **unconditional** — an unconfirmed request
must never act. Pool destroy, dataset destroy and rollback always challenge today (`confirmGateBound`
on every path) [C]; a daemon test per route pins "no code ⇒ 409 for every combination of the bound
flags", so a later change that makes one of them conditional fails CI before the UI can act on a
re-challenge. The window treats any answer other than a 409 with a code as an error shown in the window
(OK stays disabled). The generic piece lives in `confirmWindow` (`10-api.js:337-374`): an `extraItems`
entry carries `confirmBind: { query: 'cleanup' }` (built as `confirmBind`, cr.44: `bind` is ExtJS's own ViewModel config) (or `body`), and `mapConfirm` is no longer used for bound
options.

Flows where the flag decides **whether** a confirm is needed (`force` on create and import) already send it
on the first request; binding it there changes nothing in the UI.

---

## 6. Executor timeouts (M1)

### 6.1 What is unbounded today

About 380 call sites go through the executor [R, call-site pass]; 11 constructs (about 22 sites) wrap
`/usr/bin/timeout` (`services/mounts.ts:283, 1115-1118`, `source-guard.ts:204` — the only `-s KILL`,
`nested-filesystems.ts:440`, `backup-restore-files.ts` ×9, `backup-catalog.ts:118-138`,
`rclone-probe.ts:424`, `cloud-preview.ts:152`) [C for the list of `TIMEOUT` constants]. Nothing else has a
bound: not `ExecOptions`, not `execBuffered` (only `maxBuffer` and `env` reach `execFile`,
`executor/prod.ts:136-144` [C]), not Fastify (`server.ts:73-75`, no `requestTimeout`), not the gateway's
socket hop (F8). Four gaps the executor default alone cannot close:

1. **Reads that bypass the executor.** `parsers/pve-storage.ts:501-502` calls `execFile` directly for
   `zfs list` and `findmnt` when no executor is passed (POST /mounts, the iSCSI read context) [C]; and
   `pathExists` in `routes/shares-smb.ts:34-45` calls **`statSync`** on every share path [C] — from GET
   /status, GET /shares/smb and GET /shares/nfs. A share on a dead hard NFS mount blocks the daemon's
   **event loop**, every request with it, not just one slot.
2. **A hung smartctl is shared forever.** `DiskIdentityCache.get` dedupes concurrent probes through a
   `pending` map (`services/disk-identity-cache.ts:234-245`) [C]; a probe that never settles is handed to
   every later GET /disks and GET /status for that disk until the daemon restarts.
3. **The timeout must be distinguishable from absence.** Several readers turn a non-zero exit into "no
   pools" or 404 (GET /pools: non-zero with empty stdout → `data: []`, `pools.ts:871-873`; mutation
   pre-checks: unreadable list → 404, `:1039-1044`) [R]. A deadline that resolves as "exit 1, empty
   stdout" would make a suspended pool vanish from the UI.
4. **Request-path work longer than 30 s cannot reach the browser at all.** AnasProxy's `timeout => 30` is
   an inactivity timeout [P03], and the gateway sends no byte until anasd answers, so anything slower than
   30 s on the request path is a 502: the cloud preview (once `timeout 120 rclone … --dry-run`),
   the rclone remote test (once 45 s) and the PBS catalog shell (once 30 s) could all exceed it. All
   three now answer synchronously under a 12 s `timeout` wrapper (lowered at the cr.35 merge; see
   `command-budgets.ts` for the ladder: budget + 5 s TERM grace + 2 s KILL grace < the gateway's 20 s);
   making them jobs stays the open Q3.

### 6.2 Design

**Lanes.** The deadline depends on where a command runs, which the call site does not know. An
`AsyncLocalStorage` carries the lane: the daemon's `onRequest` hook enters `{ lane: 'request' }`; the queue
runs every handler inside `als.run({ lane: 'job', jobId })` (`execute` is reached synchronously from
`submit`, so without this the job would inherit the request's store); the boot scan and other background
work run in `{ lane: 'background' }`. No store means background.

| Lane | Default per command | Why |
|---|---|---|
| request | **10 s** | Medians on the stunt node are 1-60 ms, the slowest single run 185 ms [P01]: two orders of magnitude of headroom for a busy or larger node, and well inside the 20 s gateway budget even for a route that runs two reads in sequence |
| job / background | **300 s** | No single non-data-moving command in the inventory should take minutes; a hung one frees its slot within 5 minutes. Commands that legitimately take longer say so (§6.3) |

**Per call:** `exec(cmd, args, { timeoutMs })` overrides the lane: a number, or `null` for no deadline —
`null` requires `longRunning: '<reason>'` (e.g. `'zfs send|recv; ended by ssh keepalive or the run's own
cancel'`). A unit test lists every `null` site with its reason, so a new unbounded call is a visible
diff. The 11 existing `/usr/bin/timeout` wrappers stay (their exit 124 is already classified by their
callers); their executor deadline is set a few seconds above the wrapper's.

**On the deadline** (F6, P02):

1. the child is spawned `detached: true`, so it leads its own process group; the executor sends SIGTERM to
   the group (`process.kill(-pid, 'SIGTERM')`);
2. 5 s later, if any of it is still there, SIGKILL to the group;
3. 2 s after that, the executor **settles anyway**: it rejects with `CommandTimeoutError { command, args
   (redacted like the audit log), lane, budgetMs, abandoned }`. `abandoned: true` means the child has not
   exited (uninterruptible sleep); the executor keeps a registry of abandoned children (pid, command,
   since, job id) and removes an entry when that child finally exits.

All three exec paths (`execBuffered`, the tee path, `pipeline`, `execToStream`) move to the one
spawn-based implementation the tee path already is (`prod.ts:211-265`), because `execFile` cannot take
`detached` as a documented option and its own `timeout` has case B's flaw. Systemd still stops detached
groups with the daemon (F7).

**Reject, not resolve.** A timeout rejects, so no "absence" reader can mistake it for "nothing there"; a
site without a `catch` reaches a new Fastify `setErrorHandler` that answers 503 `TIMEOUT` with the
sentence "'zpool status' did not answer within 10 s — the pool may be suspended or a disk hung; nothing
was changed" (no handler exists today, so such a rejection is a bare 500 now).

**On the request path** each verb keeps its convention, made explicit:

| Convention | Families | On a timeout |
|---|---|---|
| Gate (fails closed) | system pool (cr.23), PVE footprint, LUN-held, recursive-destroy listing, composability, `requireOwnedVgPvs`, `vgs` occupancy (cr.15: 503 today) | the gate returns `{ status: 503, code: 'TIMEOUT' }`; the verb is refused, the confirm is not minted |
| Display (fails open, says so) | dashboard collectors, GET lists and details, `getfacl` (`aclDegraded`), unit status, `smbstatus`, ssh remote reads | the section reads "unavailable: <command> did not answer within <n> s" — never empty, never 404. The dashboard turns it into a warning card, so a suspended pool is visible instead of absent |
| Strict reads | `pdbedit -L`, `rclone config dump` | the existing error sentence, with the timeout named |

**Request-path work that cannot fit.** Anything that can legitimately exceed the gateway's 20 s becomes
a job: the cloud preview, the rclone remote test, the PBS catalog listing for the file-restore picker,
`zpool import` scan if it is ever measured above a few seconds on a real node **[U]**. These are reads;
as jobs they answer 202 and carry their answer in `job.result`, which `pollJob` already hands to
`onComplete`. This is a new use of the job queue for reads (Principle 4 says every mutation is a job, not
that every job is a mutation), so it is flagged for the operator (Q3). Listed in cr.35 with the call-site evidence;
the operator may prefer to keep the preview synchronous with a shorter budget (Q3).

**Gateway and proxies — a nested ladder**, so the innermost layer that knows the reason answers first:

| Layer | Today | Proposed |
|---|---|---|
| one command on the request path | none | 10 s lane default; the §6.3 rows at most **12 s** (lowered at the cr.35 merge; see `command-budgets.ts`) — and the rule is the WHOLE ladder: budget + 5 s TERM grace + 2 s KILL grace < 20 s, so even a child that ignores SIGTERM settles with the daemon's own verdict before the gateway's 504 |
| gateway → local anasd socket | none | **20 s** → 504 `GATEWAY_TIMEOUT` in the ANAS envelope, request aborted |
| gateway → peer node | 15 s, connect and response on one timer | **5 s connect, 25 s response** (a peer's own 20 s socket answer arrives before ours fires) |
| AnasProxy (pveproxy) | 30 s inactivity [P03] | unchanged |

### 6.3 The table: what the daemon runs, how long it takes, the proposed deadline

Measured: medians from P01 (stunt node, quiet, 6 small disks, no AHR pool); "—" = a write or a
long-running command, not measured (rule 3: nothing is written on the node). Lane: R request, J job, B
boot/background.

| Command (subcommand) | Lane | Measured median | Class | Proposed deadline |
|---|---|---|---|---|
| `zpool list -j`, `zpool status -jv`, `zpool get all -j`, `zpool get guid`, `zpool upgrade` (list) | R, J | 25, 22, 28, 13 ms | instant read | lane default |
| `zpool import` (device scan) | R | 145 ms (max 185) | read, scales with disk count | 12 s (lowered at the cr.35 merge; see `command-budgets.ts`), and a job if a real node shows seconds **[U]** |
| `zpool iostat -plv … 1 2` | R | 1 015 ms (by design) | sampling read | 10 s (lane) |
| `zfs list` (tree, mountpoints), `zfs get` | R, J | 38, 22 ms | instant read | lane default |
| `zfs list -t snapshot -r <pool>` | R | 34 ms (4 pools, few snapshots) | scales with snapshot count | 12 s (lowered at the cr.35 merge; see `command-budgets.ts`) **[U]** at 10k+ snapshots |
| `zfs send -nP` (plan) | R | — | read | 12 s (lowered at the cr.35 merge; see `command-budgets.ts`); better a job (cr.35) |
| `zpool create/add/attach/replace/online -e/remove/destroy/export/import <pool>/scrub/trim/set/upgrade <pool>/labelclear` | J | — | single kernel call (scrub/trim return at once) | job default 300 s; `zpool create` 1 800 s (it discards every device unless `-K`; minutes on large SSDs **[U]**) |
| `zfs set/create/destroy/rename/clone/rollback/snapshot/hold/release` | J | — | seconds | job default; `zfs destroy -r` 1 800 s **[U]** (thousands of snapshots) |
| `zfs send` → `[ssh] zfs recv` pipeline | J | — | data mover, hours | `null` (`longRunning`); add `ServerAliveInterval=15`, `ServerAliveCountMax=4`, `ConnectTimeout=10` to the ssh argv (none today, `replication-transport.ts:90-104`) so a dead peer ends the pipe |
| `ssh` remote reads (`zpool list`, `zfs list`, holds, `zfs --version`), `ssh-keyscan` | R, J | — (network) | remote read | 12 s (lowered at the cr.35 merge; see `command-budgets.ts`) with `ConnectTimeout=10`; `ssh-keyscan -T 10` |
| `smartctl -n standby -iH --json`, `-a --json` | R | 24, 38 ms (QEMU disk) | read; a USB bridge or a waking SAS disk can take seconds **[U]** | 12 s (lowered at the cr.35 merge; see `command-budgets.ts`); the timeout rejection also clears the `pending` dedup (gap 2) |
| `lsblk`, `ls /dev/disk/by-*`, `realpath`, `readlink`, `blkid` | R, J | 34, —, —, —, 47 ms | instant read | lane default |
| `cat /proc/mdstat`, `/sys/block/md*/md/*`, `mdadm --detail/--examine` | R, J, B | 1, —, 1 ms | instant read | lane default |
| `mdadm --create/--grow/--add/--add-spare/--remove/--replace/--re-add/--fail/--zero-superblock/--stop`, `--action=` | J | — | returns at once; the kernel does the work | job default |
| `mdadm --run/--readwrite`, `vgchange -ay`, boot `mount` | B | — | seconds | background default (300 s) |
| `pvs`, `vgs`, `lvs`, `dmsetup status/table` | R, J, B | 42, 44, 39 ms | instant read | lane default |
| `pvcreate/vgcreate/lvcreate/vgextend/lvextend/pvresize/lvconvert/lvremove/vgreduce/vgremove/pvremove` | J, B | — | seconds | job default |
| `sgdisk`, `wipefs -a`, `partx -a` | J | — | seconds | job default |
| `udevadm settle` | J | 16 ms (idle queue) | waits for udev | pass `--timeout=60` (none today, 7 sites); executor 90 s |
| `mkfs.btrfs` | J | — | discards the device by default | 1 800 s **[U]** |
| `btrfs subvolume list/show`, `btrfs filesystem usage` | R, J | — (no AHR pool on the node) | instant read | lane default |
| `btrfs subvolume create/snapshot/delete`, `filesystem resize`, `scrub start/status`, `inspect-internal` | J | — | seconds (scrub start returns at once) | job default |
| `findmnt` | R, J, B | 2 ms | instant read | lane default |
| `mount`, `umount` (incl. `-l`) | J (and R inside `withTopLevelMount` on GET /ahr/:name/snapshots) | — | a remote mount can hang | job default; the probe mount keeps `timeout 15`; its follow-up `umount` (`mounts.ts:1120`) gets 15 s; the R-path top-level mount gets the lane default |
| `stat` (unwrapped: `access.ts:332`, `ahr-scrub.ts:1019`), share `pathExists` (`statSync`) | R | 8 ms (`timeout 2 stat -f /`) | can hang on dead storage | `timeout 2 stat` through the executor, like `mounts.ts:283`; `statSync` removed (gap 1) |
| `lsof +f --`, `fuser -m` | R, J | — | walks /proc; hangs where the mount hangs | 10 s |
| `getfacl` | R, J | 6 ms | read | lane default |
| `setfacl -R`, `chown -R`, `chmod -R`, `find … -exec chmod` | J | — | tree-sized, hours | `null` (`longRunning: 'recursive ACL apply'`); candidate for a cancel hook (grooming) |
| `getent`, `pdbedit -L` | R, J | 8, 57 ms | read | lane default |
| `useradd/usermod/userdel/groupadd/groupdel/gpasswd/smbpasswd` | J | — | seconds | job default |
| `smbstatus --json/-S`, `testparm -s` | R, J | 43, 31, 43 ms | read | lane default |
| `systemctl reload smbd`, `exportfs -ra` | J | 5 ms (`exportfs -v`) | seconds | job default |
| `systemctl show/is-active/is-enabled`, `systemd-escape`, `systemd-analyze calendar`, `journalctl -u … -n` | R, J | 29, —, —, —, 6 ms | read | lane default |
| `systemctl daemon-reload/enable/disable --now/reset-failed/start --no-block/stop` | J | — | seconds | job default |
| `targetcli` (one command per call) | J, and **R** (placeholder-LUN quarantine on GET /iscsi/health and GET /status, `services/iscsi-quarantine.ts:139, 144` [R]) | — | seconds | job default; the R-path quarantine is a write on a GET (noted, §8.4) |
| `ip -j addr`, `pve-firewall status` | R | — | read | lane default |
| `rclone version/config providers/config dump/obscure` | R, J | — | read | lane default |
| `rclone sync/copy` (run) | J | — | data mover | `null`; supervised by its cancel hook (no SIGKILL by contract, `jobs/child-cancel.ts:11-17`) |
| `rclone lsjson` probe, `rclone --dry-run` preview | R | — | network | `timeout 12` each (lowered at the cr.35 merge; see `command-budgets.ts`), rclone's own `--timeout 9s` / `--contimeout 10s` inside, executor +5 s; both should become jobs (gap 4, Q3) — **done in cr.48: read jobs, `timeout 120` / `timeout 600`** |
| `proxmox-backup-client` reads (snapshots, groups, repo probe) | R | — | network | 12 s (lowered at the cr.35 merge; see `command-budgets.ts`); `catalog shell` wraps its own `timeout 12` → a job (Q3) — **done in cr.48: the listing is a read job under `timeout 300`; the restore pre-flight's session stays 12 s** |
| `prlimit -- proxmox-backup-client backup`, pbc file and image restores | J | — | data mover | `null`; backup has its cancel hook; `execToStream` ignores `onSpawn` today (`prod.ts` calls `announceSpawn` only at `:174, 220`), so image restores cannot be cancelled — fixed in cr.34 so the hook exists |
| `perl -e 'use PVE::Notify; …'` | J, B | — | sends mail through PVE | 60 s; best-effort by contract, a timeout is a warning |
| `dd`, `dd | base64`, `sync` (self-heal block I/O) | J | — | one block | job default |
| `update-initramfs -u` | J | — | tens of seconds **[U]** | 600 s |

### 6.4 What a killed command leaves behind

| Command | Killed while… | Leaves | Evidence |
|---|---|---|---|
| any read (`zpool status`, `zfs list`, `lsblk`, `smartctl`, `mdadm --detail`, `pvs`, …) | reading | nothing | reads only |
| `zpool status/list` on a **suspended** pool | blocked in the kernel | the process may stay in D state until the pool resumes; it is abandoned, not killed | **needs a node check** (does `zpool status` block at all on a suspended pool with `failmode=wait`, or does it answer from the cached config?) |
| `zpool create` | between labelling the disks and the create ioctl | labelled disks with no pool | **needs a node check** |
| `zfs destroy -r` | mid-way | some descendants destroyed (libzfs iterates in user space) | inference **[U]** |
| `zpool export/import/destroy` | in the ioctl | the ioctl completes or not as a whole; the signal is delivered on return | inference **[U]** |
| `mdadm --create` | between superblock writes and `RUN_ARRAY` | superblocks without a running array | **needs a node check** |
| `mdadm --grow/--replace/--add` | after the ioctl | nothing: the kernel owns the reshape (ANAS uses no backup file, `ahr-expand-exec.ts:201-206` [R]) | inference |
| LVM commands | mid-transaction | LVM's own metadata transaction and archive; a stale lock in `/run/lock/lvm` is possible | **needs a node check** |
| `sgdisk`, `wipefs` | mid-write | a partly written table or signature | **needs a node check** |
| `targetcli` | mid-command | a live tree without `saveconfig` (GT-5's half-applied state) | GT-5 (`withIscsiLock` comment, `iscsi-mutate.ts:150-153` [C]) |

So a deadline on a mutating command is a slot-freeing measure with an honest failure, not a rollback:
the job fails "`<command>` did not finish within <n> s and was stopped; the state of <object> is unknown —
check it before retrying", and, when the child was abandoned, the job keeps its object locks (§4.4) until
the child exits. The generous job budgets in §6.3 are chosen so that this path is reached only by a
genuinely hung command.

---

## 7. `pollJob` and the job feedback (M5, second bullet, plus its two other UI items)

### 7.1 What goes wrong today (F9)

| Defect | Effect the operator sees |
|---|---|
| One failed poll stops polling and fires no callback (`10-api.js:286-289`) | A gateway blip, a daemon restart or a 502 from AnasProxy leaves the screen as `onSubmitted` left it: a grid that never reloads, a staged disk that never bounces back (`39-ahr.js:1968-1974`), an "in progress" state with no end |
| A job still running at the end of the window is reported to `onComplete` (`:278-284`) | Every AHR long verb (expand, replace, readd, spare) runs on the 15 s default: its "completion" reload happens while md is still working; a later failure of that job is never alerted (only the dashboard strip shows `failed`). The cancel-run flow toasts "Run cancelled" for a cancel still in progress (`69-schedules-common.js:237-239` via `onComplete`) |
| A job the daemon no longer knows (restart; jobs are in memory) answers 404 | Today indistinguishable from any failed poll: silent stop |

### 7.2 Design

```
poll every 0.5 s for the first 5 s, then every 2 s
  completed  → successMsg toast, onComplete(job)               (unchanged)
  failed     → alert (encoded, cr.11), onFailed(job)            (unchanged)
  cancelled  → onCancelled(job) or the toast                    (unchanged)
  running past opts.maxMs (the "attention window", default 15 s)
             → once: onStillRunning(job), default toast "<what> is still running — the Dashboard's
               Recent activity shows when it ends"; keep polling every 5 s while the view lives;
               onComplete fires only on `completed`
  poll error 404 NOT_FOUND for the job
             → terminal "lost": alert "The node no longer knows this job (the ANAS daemon restarted).
               Check the object before retrying."; onLost(err) if given, else onFailed(null)
  poll error anything else (network, 502, 503, 504)
             → retry after 1, 2, 4, 8, 10, 10 … s; the first success resumes normal polling;
               60 s without any successful poll → terminal "lost contact": alert "Lost contact with
               the node while <what> was running; it may still be running. Refresh to see the result.";
               onLost(err) if given, else onFailed(null)
  view destroyed → stop silently                                (unchanged)
```

Why `onFailed(null)` for "lost": every `onFailed` in the panels reloads a grid or re-enables what
`onSubmitted` disabled (every `onFailed` callback in `packages/pve-integration/src`, re-read for this
pass), which is the right recovery when the
outcome is unknown; `jobRejected` already calls `onFailed(null)` the same way (`10-api.js:225-226`). A
caller that must tell "lost" from "failed" passes `onLost`. Why keep polling a long job at 5 s rather than
hand it to the jobs strip: the strip is display-only and lives on the Dashboard; the dialog that started
the job is where the operator expects the failure alert, and the cost is one small GET every 5 s while
that view is open (the daemon already serves the strip's 20 jobs every poll of `/status`).

`maxMs` keeps its name and changes meaning from "stop polling" to "tell the operator it is still
running"; the overrides that exist only to keep polling (600 s backup/cloud Run Now, 3 600 s restores)
become unnecessary but harmless. `casWrite`'s inner `pollJob` (`10-api.js:477-483`) inherits all of it.

### 7.3 The review's two other M5 items

| Item | Decision | Reason |
|---|---|---|
| Replication task delete calls `ANAS.api.del` directly (`65-replication.js:2174-2184` [C]): "deleted" toast on 202, a failed job never shown, a 409 unhandled | **Include** (cr.46) | One call site; the route is a 202 job (`routes/replication-tasks.ts:281-302` [C]); through `runJob` it gets the failure alert and the reload for free. The snapshot-schedule delete hand-rolls the same thing with `pollJob` (`69-snapshots.js:1453-1467` [C]) and moves with it |
| Poll loops re-select by the name captured at request start (`65-replication.js:368-401`, `68-backup.js:1731-1767`, `69-scrubs.js:650-705` [C]) and have no load sequence | **Include** (cr.46) | Mechanical: read the selection when the response arrives, not when the request leaves, and drop a response older than the newest request (a per-grid sequence number, the `_previewSeq` idiom that already exists in `72-cloud.js:3562-3566` [C]) |
| Seven copies of the timed poll loop (`grep setInterval`: dashboard, schedules, replication, mounts, cloud ×2, backup, iSCSI) | **Defer** to grooming | Consolidation touches every menu for no behaviour change; the two defects above are fixed per copy |
| Seven files with plain `runJob` and client-side "are you sure" prompts (M5 last bullet) | **Fold into the guard rollout** | When a verb gains a daemon confirm (§5) its panel moves to `confirmAndRun` in the same story; no separate UI sweep |

---

## 8. Failure modes, tests and the node proof

### 8.1 Failure modes of the design

| Failure | What happens | Mitigation |
|---|---|---|
| A gate cannot read its fact in the job | the job fails `UNAVAILABLE` / `TIMEOUT` with the gate's sentence | fail closed is the rule (§3.2); the operator re-runs after fixing the read |
| A job waits hours behind a lock and the object changed | id, revision or a gate refuses; the job fails `IDENTITY_MISMATCH` / `STATE_CHANGED` / the gate's code, nothing done | the point of ruling (j) |
| The object changed in a way no gate models | acts on the new state | the revision check covers edit-shaped verbs; destroy-shaped verbs bind scope |
| A long job releases its lock to wait and another verb changes the object | its next `reguard()` refuses; the step is not taken | for AHR the intent file keeps refusing structural verbs while an expansion exists (unchanged) |
| An abandoned child | locks stay held; the job failed; the dashboard shows "a command did not end" | §4.4, §6.4; a daemon restart clears it (and the systemd cgroup stop kills the child if it ever wakes) |
| The daemon restarts mid-job | jobs, locks and polls vanish; `pollJob` reports "lost" (7.2) | kernel state is the truth; AHR expansion resumes from the intent |
| A lane cannot be determined | background lane (300 s) | no store ⇒ background |
| Re-challenge on a verb whose confirm became conditional | the unconfirmed request would act | the daemon test that pins "no code ⇒ 409" for every bound-flag combination (§5.3) |
| 4 long jobs | a short verb waits for a slot | the long-lane reservation (§4.3) |

### 8.2 Test strategy (ruling (l): fakes print captured output)

- **Guard.** Unit tests over a fake `ObjectView`: every gate in `spec.gates` runs at both doors (a spy per
  gate); id, revision and scope mismatches each give their code; a refusal's `code` becomes the job's
  `error.code`. **Mutation check:** drop a gate from the job run → a test fails; compare revision with
  `!==` inverted → a test fails.
- **Race tests per verb** (the H8 property itself): the test harness gets a pausable queue (`autostart:
  false`, `drainNow()`); the test sends the confirmed request, flips the fixture to the refusing state
  (a LUN appears, a child dataset appears, a disk becomes a member, a session logs in), drains, and
  asserts the job failed with the refusal's code and that **no mutating argv** reached the mock executor.
  One race test per row of §2 that has a non-empty "Missing" cell. The fixture flips use captured
  outputs (`fixtures/`), never typed strings.
- **Locks.** Queue tests: S/S run together, S/X and X/X serialise, a queued X blocks later S (FIFO), a
  lock-blocked job does not take a slot, the long-lane cap, release on throw, held-on-abandon.
- **Bound confirms.** Per confirmed route: a code minted with flag A, resent with flag B → 409
  `CONFIRM_SCOPE_CHANGED` naming the flag; a child created between challenge and resend → 409 naming it.
  A table test lists every route's `presentationOnly` keys. For the three re-challenge routes: no code ⇒
  409 for every flag combination. **Mutation check:** remove `cleanup` from the signature → the test fails.
- **Executor deadlines** with the real `ProdExecutor` on `/bin/sh` children (P02's four cases with 200 ms
  budgets): (A) on time; (B) a TERM-ignoring child is SIGKILLed and the promise settles; (C) the
  grandchild is gone (a `pgrep` on a unique marker, as P02 does); (D) a child whose kill is a no-op (the
  spawn seam injected) settles as `abandoned` and the registry lists it until it exits. **Mutation
  checks:** remove the SIGKILL step → B hangs and the test times out; kill the pid instead of the group
  → C finds the orphan; remove the settle-anyway timer → D hangs.
- **Lanes.** A route handler that submits a job: the command inside the job gets the job budget, the
  read before the reply gets the request budget (asserted through the executor's recorded options).
- **Request-path timeout conventions.** A mock that never answers `zpool status`: GET /pools answers 503
  `TIMEOUT` (not `data: []`), GET /status shows the "unavailable" warning, a destroy is refused 503 before
  any confirm is minted.
- **UI.** `pollJob` harness over a fake `api.get` sequence (the `csrf-token.harness.mjs` /
  `alert-encoding.harness.mjs` idiom, `packages/pve-integration/test/`): [error ×3, running, completed];
  [404]; [error for 61 s]; [running past the window, then failed]. Assert each callback and alert.
  **Mutation check:** restore the old "stop on error" branch → the first sequence fails. `confirmWindow`
  harness: ticking a bound option re-sends without a code and replaces warnings and code.

### 8.3 Node proof (stunt node, Opus node pass)

| # | Proof | How |
|---|---|---|
| N1 | A destroy that waited behind a lock refuses a LUN that appeared meanwhile | start a replication from a dataset of `gtiscsi` (S claim), queue a pool destroy (X waits), create a LUN on a zvol of that pool by hand, let the replication end → the destroy job fails with the LUN refusal, the pool is intact |
| N2 | A recursive destroy refuses a child created after the confirm | confirm, create a child by hand before the resend → 409 naming it; with the job held behind a lock → `STATE_CHANGED` |
| N3 | Cleanup's wipe warning is shown before the confirm | Playwright: Destroy → tick "Clean up disks" → the warning list gains the wipe line and the leaf by-ids; OK sends the code minted for `cleanup=true` |
| N4 | A hung read is bounded | a single-disk file-backed pool on a loop device with `failmode=wait`, its backing made unavailable (`dmsetup suspend` of a dm-linear in front, or detach a hot disk with `remove-disk.sh`): measure whether `zpool status` blocks (§6.4 node check), then GET /pools → 503 `TIMEOUT` within 10 s, GET /status shows the warning, the gateway answers before AnasProxy (no synthetic 502), the abandoned child is listed; resume the device, the child exits, the registry empties |
| N5 | A dead hard NFS mount does not freeze the daemon | an NFS share as an SMB share path, the server's port blocked: GET /status and GET /shares/smb still answer (the `statSync` removal) |
| N6 | What killed mutating commands leave (§6.4 "needs a node check") | on throwaway loop devices only: kill `zpool create` after labelling, `mdadm --create` mid-way, an `lvremove`; record the leftovers |
| N7 | `pollJob` lost / still running | stop `anasd` for 70 s while a dialog polls → "lost contact" and the dialog re-enabled; start it → a job id answers 404 → "the node no longer knows this job"; an AHR spare add past 15 s shows "still running" and later its completion |
| N8 | The ladder on a cluster | not available on the single stunt node **[U]**; the forward change (5 s connect / 25 s response) is unit-tested against a black-holed address and a slow server |

### 8.4 Noted, outside this wave

- GET /iscsi/health and GET /status can run `targetcli` deletes (placeholder-LUN quarantine,
  `services/iscsi-quarantine.ts:139, 144` [R]): a write on a GET, outside the job queue (Principle 4), and
  it would be refused by cr.28's queue rule only if it were a job. Groom as its own story.
- Backup repo create/update write the secret before the registry CAS can fail
  (`routes/backup.ts:385, 461` [R]); a lost CAS leaves a rotated secret.
- The AHR boot scan serves requests before it finishes (`index.ts:67-79` [R]); with locks, its work should
  be submitted as jobs with claims (cr.38 covers the cache rung; the rest is grooming).
- `withFileLock`'s map never drops a key (`file-lock.ts:15-22` [C]); harmless at today's key counts,
  but the lock table in cr.33 must delete idle keys.
- Review M2's "add vdev and raidz expansion have no confirm" stays M2's: irreversible is not
  data-destroying, so EPICS' Safety altitudes would make it an advisory amber gate, not a confirm. The
  guard makes either a one-line change.

---

## 9. Proposed stories (cr.32 onwards)

Lanes per the local-delegation hints and the brief: **Opus** for anything destructive, security-shaped or on
the request path; **local** only for mechanical slices with a fixed spec and a gate. Every story: guard
specs written from §2's row (the row is the acceptance list), a race test per "Missing" cell (§8.2),
numbered WIP commits, `npm run -s typecheck` beside lint and the areas.

**Order.** cr.32 → cr.33 → (cr.36 … cr.43 in any order, each one merge); cr.34 → cr.35 independent of the
guard chain; cr.44 (UI) **before** the daemon binds the destroy flags (an old daemon ignores the explicit
`?cleanup=false` and verifies the re-challenged code, so UI-first is harmless; daemon-first would make every
cleanup destroy re-prompt); cr.45 and cr.46 independent.

| Story | Scope | Files (main) | Acceptance | Depends | Lane |
|---|---|---|---|---|---|
| **cr.32** The guard and bound confirms (mechanism only) | `safety/guard.ts`: `Refusal`, `Gate`, `ObjectView` (id, revision, scope), `GuardSpec`, `guardCheck`, `guardConfirm` (bind the whole validated request, `presentationOnly`), `guarded` (read → id → revision → scope → gates → advisories → body, `ctx.reguard`). `ConfirmStore.explainMismatch`. Error codes `STATE_CHANGED`, `CONFIRM_SCOPE_CHANGED`, `TIMEOUT` in `shared/schemas/api.ts`. Port pool export and pool destroy as the two reference specs (gates: exists, system pool, PVE ownership — Q2, LUN-held; references as advisories; cleanup + leaf set bound) | `safety/guard.ts`, `safety/confirm.ts`, `routes/pools.ts`, shared `api.ts` | §8.2 guard tests and mutation checks; race tests: a LUN appearing and a system mount appearing between confirm and job both refuse export and destroy with no mutating argv; the cleanup flag bound | — | Opus |
| **cr.33** Per-object locks and the long lane in the queue | `submit(…, { locks, lane })`; grant-all-or-nothing in `drain`, per-key FIFO, S/X; waiting progress line; release in `finally`, held on abandon; long lane ≤ 3 of 4 slots; idle keys deleted; key builders (`zpool:`, `zfs:`, `zname:`, `ahr:`, `ahrname:`, `disk:` …) | `jobs/queue.ts`, `safety/guard.ts` | §8.2 lock tests; a lock-blocked job never holds a slot (asserted on `running`) | cr.32 | Opus |
| **cr.34** Executor deadlines | One spawn-based implementation for all paths (`detached`, process-group TERM → 5 s → KILL → 2 s → settle `abandoned`); `CommandTimeoutError`; lanes via `AsyncLocalStorage` (`onRequest` hook, queue `execute`, boot); `timeoutMs` / `longRunning`; abandoned registry on GET /health and a dashboard warning; daemon `setErrorHandler` (503 `TIMEOUT`); `execToStream` honours `onSpawn` | `executor/*`, `jobs/queue.ts`, `server.ts`, `index.ts`, `routes/health.ts`, `routes/dashboard.ts` | P02's four cases as tests with their mutation checks; lane tests; the `null`-site table test | — | Opus |
| **cr.35** Request-path budgets and the gateway ladder | The §6.3 per-site budgets; `statSync` in `pathExists` → executor `timeout 2 stat`; `pve-storage.ts` direct `execFile` → executor; ssh `ConnectTimeout`/`ServerAlive*`, `ssh-keyscan -T`, `udevadm settle --timeout`; smartctl 20 s (clears the `pending` dedup); the long request-path reads per Q3; dashboard "unavailable" cards; gateway socket proxy 20 s → 504, cross-node forward 5 s connect / 25 s response | listed sites, `packages/gateway/src/proxy.ts` | a never-answering mock per convention row gives 503 / "unavailable" / refusal, never empty; gateway test with a socket that never answers; live smoke N4/N5 | cr.34 | Opus (request path) |
| **cr.36** ZFS pool verbs on the guard | upgrade and mountpoint bound to the guid; create/add/attach/replace/raidz-expand/remove: `disk:` claims, composability re-run in the job, `vdevTopologyGate` on the attach family, leaf/token re-resolved; create/import `force` bind the whole request | `routes/pools.ts` | every §2.1 pool row's "Missing" closed with a race test | cr.33 | Opus |
| **cr.37** ZFS dataset and snapshot verbs on the guard | destroy binds the descendant guid set; rollback re-runs ownership and LUN-held, binds `force`; create/snapshot/clone/rename/set re-run ownership; `fs.setAccess` (ZFS, AHR, shares) binds its plan and the ACL revision | `routes/datasets.ts`, `services/access.ts`, `routes/share-access.ts`, `routes/ahr-access.ts` | §2.1 dataset rows closed; a child created after the challenge → 409 / `STATE_CHANGED`; an ACL entry added after the plan → `STATE_CHANGED` | cr.33 | Opus |
| **cr.38** AHR verbs on the guard | `ahr:<vg uuid>` keys; destroy re-runs in-flight/intent/system/LUN; mountpoint/remount/rollback gain the system-pool gate and re-run LUN-held; expand/resume/replace re-run composability, `requirePoolVg` before cache `vgextend`; cache attach refuses a disk with any signature (`blkid -p`); create binds disks/tier/mountpoint; parity/mirror bind the band UUID; abandon checks the intent id/state; long verbs release around md waits and `reguard` per step; the boot cache rung and the udev cache event submit jobs | `routes/ahr-*.ts`, `services/ahr-*.ts`, `index.ts` | §2.3 rows closed with race tests; the stunt-node AHR fixtures (`ahrcache-fixture.sh`, `ahrexpand-fixture.sh`) re-run | cr.33 | Opus (may run as two sessions: short verbs, then long verbs) |
| **cr.39** Mount verbs on the guard, and the missing reference check | LUN-held re-run in the job; non-persistent create re-checks the fstab entry; update binds the line's revision; remove always confirms and binds `removeMountpointDir`; unmount/disable/remove list shares, exports, backup and cloud tasks riding the path (cr.24's helper, warn per Q4) | `routes/mounts.ts`, `services/pool-references.ts` | §2.5 mount rows closed; the EPICS §2 Mounts sentence becomes true | cr.33 | Opus |
| **cr.40** iSCSI and image restore on the guard | target update/state/delete bind the target revision (ACLs, portals, LUNs, enabled) and re-run sessions/LUN count; LUN add takes index and ACL grants from the fresh target; `reverifyServedLun` compares sessions; LUN delete binds `destroyBacking` and re-runs the snapshot check; image restore reads `enabled` fresh; new-LUN restore uses the fresh target | `routes/iscsi-mutate.ts`, `services/iscsi-*.ts`, `services/backup-restore.ts`, `routes/backup.ts` | §2.4 iSCSI rows closed; a session logging in between confirm and job refuses the LUN delete | cr.33 | Opus |
| **cr.41** Tasks, schedules and registries on the guard | schedule run re-reads the schedule; unit-store update binds the unit revision (no resurrection) and create takes the name key; delete during an active run per Q1; backup repo secret written after the CAS; repo IN_USE and remote/cloud reference checks re-run in the job | `routes/schedules.ts`, `routes/*-tasks.ts`, `routes/backup.ts`, `routes/cloud.ts`, `routes/replication-remotes.ts` | §2.4 task rows closed with race tests | cr.33, Q1 | local (DeepSeek), spec = §2.4 + Q1 ruling; cross-model review |
| **cr.42** Identity verbs on the guard | uid/gid as the id (the job compares, never uses the request-time uid); share references and primary-group use re-run in the job | `routes/share-identity.ts` | a user deleted and re-created under the same name between confirm and job → `IDENTITY_MISMATCH` | cr.33; after cr.29 if it lands first | Opus (destructive, identity) |
| **cr.43** Share verbs on the guard | SMB/NFS update/remove fail `NOT_FOUND` when the share vanished; add refuses an existing stanza under the lock; `exportfs -ra` baseline and reload inside the lock | `routes/shares-smb.ts`, `routes/shares-nfs.ts` | the three "reports success for a vanished share" cases refuse; no duplicate stanza | cr.33 | local (Qwen), fixed spec |
| **cr.44** Bound options re-challenge in the confirm window | `confirmWindow` `bind:` items; the three flows (pool destroy cleanup, dataset destroy recursive, rollback force) send their default explicitly; `REPROMPT_CODES` gains `CONFIRM_SCOPE_CHANGED`; daemon test pinning "no code ⇒ 409" for every combination on the three routes | `10-api.js`, `37-pool-destroy.js`, `60-datasets.js`, daemon route tests | harness test; Playwright N3 | — (before cr.36/cr.37 bind the flags) | Opus (destructive flows) |
| **cr.45** `pollJob` retry, lost and still running | §7.2 exactly; `onStillRunning`, `onLost`; the cancel-run flow toasts only on `completed` | `10-api.js`, `69-schedules-common.js` | harness sequences and the mutation check (§8.2); browser probe N7 | — | local (Glimmer/Qwen), fixed spec; browser probe owed |
| **cr.46** Replication delete through `runJob`; selection by response | §7.3 rows 1–2 (`65-replication.js`, `69-snapshots.js`, `68-backup.js`, `69-scrubs.js`) | as listed | harness or Playwright: a selection made while a refresh is in flight survives it | — | local (Glimmer), fixed spec |

---

## 10. Open questions for the operator

1. **Delete of a task or schedule while its run is active** (audit #39; today every delete ignores a
   running run and the job carries on, `services/task-units.ts:244-260` [R]). Recommendation: refuse with
   409 "a run is in progress — wait for it or cancel it" (a state to refuse, like a live iSCSI session).
   Alternative: allow and let the run finish unowned.
2. **Pool export and destroy of a PVE-owned (non-system) pool.** The code has no PVE-ownership gate on
   either verb although its own comment says they "stand behind" one (`pools.ts:793-797`); the panel only
   greys the buttons. Recommendation: refuse (409 `PVE_MANAGED`, "PVE territory is read-only and
   hands-off"). Needs a yes because it would refuse something the API accepts today.
3. **Request-path reads that cannot finish within 30 s** (cloud preview up to 120 s, rclone remote test
   45 s, PBS catalog listing 30 s): today they already die at AnasProxy's 30 s (P03). Recommendation: make
   them jobs (202, the answer in `job.result`). Alternative: keep them synchronous with a 20 s budget and
   accept "timed out" on slow remotes. Note for cr.28: a job requires `Sys.Modify`, so a read that is a
   GET today (the catalog listing) would need `Sys.Modify` as a job, or the queue rule would need a
   read-job exemption.
   **Ruled 2026-10-15: jobs.** Built as cr.48 — each is a cancellable READ job (operation prefix `read.`,
   `jobs/read-jobs.ts`) with a ceiling of minutes (preview 600 s, remote test 120 s, catalog listing 300 s);
   a read job is cancelled without a confirm, and cr.28 admits it on `Sys.Audit`.
4. **Mounts: the unmount reference check the ruling describes does not exist.** Build it as cr.24 does for
   pools (name each share, export and task riding the path in the confirm; never refuse), or refuse while
   a share rides the path? Recommendation: warn, as for pools (one failure-mode rule for both).

---

## Appendix: probe files

| File | What |
|---|---|
| `docs/probes/wave3/timing.sh` | the read-only timing probe (33 commands × 7 runs) |
| `docs/probes/wave3/01-read-timings.txt` | its output on the stunt node, 2026-10-15T06:02Z (P01) |
| `docs/probes/wave3/exec-timeout-semantics.mjs` | the Node `execFile` timeout probe, cases A–D |
| `docs/probes/wave3/02-exec-timeout-semantics.txt` | its output locally (Node 26.11.1) and on the stunt node (Node 22.23.3) (P02) |
| `docs/probes/wave3/03-anyevent-http-timeout.txt` | `AnyEvent::HTTP`'s `timeout` documentation from the node's package (P03) |
