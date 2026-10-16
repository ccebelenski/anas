# Live proof — 0.4.4 wave 2b (cr.47e / cr.47(c) clones and zvols, cr.41b, cr.33c, the integration specs), stunt node

Node: the stunt node (PVE 9 / pve-manager 9.2.21, kernel 7.0.14-23-pve, zfs-2.4.4-pve1, systemd 257.13-1~deb13u1,
Node v22.23.3), the same node and method as [wave 2](LIVE-PROOF-0.4.4-wave2.md), 2026-10-16 UTC, 05:37–08:05. The VM was
running the wave-2 build (main at `455ff82`) at the start; no snapshot was restored (`authkey.pub` mtime 1792085540 <
now 1792129037, root login with `anas-test` worked). The PBS VM anas-pbs stayed shut off: nothing in this pass needed it
(every backup run went to a blackholed repo).
Build: worktree fast-forwarded `026bf64..7ed186f` (main HEAD at the start; contains cr.47e `a4046b0`, cr.41b `ce254e8`,
cr.33c `3025c9c`, cr.29e `ea15aa2` + `3d70e18`, cr.48b–e, nf.3b, cr.47b and their review records). Main did not move during
the pass. ADOCK is installed on the same node; none of its pieces were edited, stopped or redeployed (row 5 table).

Methods as in wave 2: API calls through the gateway exactly as the panels go (`https://<node>:8006/anas/api/nodes/
anas-pve/v1/...`, root@pam ticket + CSRF token), with wave 3's client (`docs/probes/wave3-node/api.sh`, `lib.sh`) wrapped
by `docs/probes/wave2b-node/a.sh` so its session and temp files stay inside the worktree (`.w2btmp/`, never committed);
calls over the daemon's unix socket are `curl --unix-socket /run/anas/anasd.sock` on the node with the identity headers
spelled out. Every probe is a script under `docs/probes/wave2b-node/` and its raw output is under
`docs/probes/wave2b-node/out/` (`run.sh <script> <log> [args]` runs one).

Two new read-only instruments, both reversible and both gone at the end of the pass:
- **Bind-mounted wrappers** (rows 2 and 3). To make one systemd or mdadm read fail without editing anything on disk, a
  wrapper script (or a mode-0644 copy) is `mount --bind`-ed over `/usr/bin/systemctl` or `/usr/sbin/mdadm` for the length
  of one request or run, and unmounted after; the wrapper answers exactly one argv with a failure and `exec`s a copy of
  the real binary for everything else. The binaries' sha256 before and after are in the logs (identical).
- **A logpoint** (row 3, `logpoint.mjs`): a V8 inspector breakpoint whose condition logs one line and answers false, set
  in the running anasd (the inspector opened with `kill -USR1`, as wave 3's `held-locks.mjs` does). It never pauses the
  daemon and goes away with its session. Used to read a progress line that is replaced within a millisecond.

Throwaway objects carry a `w2b` prefix: pool `w2bz` on a sparse file under `/var/tmp/w2b/`; dataset `gtbackup/w2bsrc`;
nft table `inet w2bbh` (drops everything to 192.0.2.10, a peer that never answers); backup repo `w2bbh`; backup tasks
`w2bt1..w2bt4`; throwaway unit files `w2bbad-{a..f}.service` under `/run/systemd/system`; the hand-built AHR pool `w2bahr`
(md `w2bahr-r1`, VG `w2bahr`) on two NEW hot disks hot20/hot21 (images created and deleted by the row-3 fixture). Row 4's
specs create their own named objects, each removed by the spec or its fixture.

Classification key (brief rule): (a) stale test expectation, (b) test/script bug, (c) node fact. A product defect is
recorded as **D<n>** (numbering continues wave 2's: D12 onward) with a repro, a severity and the suspected file:line.

---

## R0 — deploy

```
host$ git merge-base HEAD main -> 026bf64 (= HEAD);  git merge --ff-only main  026bf64..7ed186f   (contains 7ed186f6)
host$ npm ci; ./test/stunt-node/deploy-anas.sh                    (out/deploy.log)
  ✓ anasd active, 0 restarts, /v1/health answers version 0.4.3
  ✓ anas active, /installed answers the same version
  anas: proxy hook already present in …/AnyEvent.pm and AnasProxy.pm unchanged (nothing to do)
host vs node, sha256 of every file under packages/{daemon,gateway,shared}/dist (2204 files, LC_ALL=C sorted list):
  IDENTICAL; hash of the list c4bb2d5209c89d40   (out/dist-hashes.log)
  AnasProxy.pm host = node c6beac85a012f590 (unchanged since wave 2, so pveproxy was not reloaded)
```

**Verdict: PROVEN** — `7ed186f` deployed and running; the node's dist is byte-identical to this worktree's.

---

## Row 1 — cr.47e / cr.47(c): clone origins and zvols under a recursive destroy

### 1a. Pure ZFS (`r1-zfs-clone-zvol.sh`, `out/r1-zfs-clone-zvol.log`)

Pool `w2bz` on a 1 GiB sparse file, rebuilt before each case. zfs-2.4.4-pve1, kernel 7.0.14-23-pve. Verbatim:

```
==================== (a1) zfs destroy -r of a tree whose child w2bz/t/o@s is the origin of w2bz/c (outside the tree)
before:
  | w2bz	filesystem	-
  | w2bz/c	filesystem	w2bz/t/o@s
  | w2bz/t	filesystem	-
  | w2bz/t@s	snapshot	-
  | w2bz/t/a	filesystem	-
  | w2bz/t/a@s	snapshot	-
  | w2bz/t/o	filesystem	-
  | w2bz/t/o@s	snapshot	-
  | w2bz/t/o/g	filesystem	-
  | w2bz/t/o/g@s	snapshot	-
  | w2bz/t/z	filesystem	-
  | w2bz/t/z@s	snapshot	-
$ zfs destroy -r w2bz/t
exit code: 1
stdout:
stderr:
  | cannot destroy 'w2bz/t': filesystem has dependent clones
  | use '-R' to destroy the following datasets:
  | w2bz/c
zfs list -t all -r -o name,type,origin w2bz  (after):    — all twelve rows above, unchanged

==================== (a2) the same tree, dry run: zfs destroy -rnv w2bz/t
$ zfs destroy -rnv w2bz/t
exit code: 1
stdout:
stderr:
  | cannot destroy 'w2bz/t': filesystem has dependent clones
  | use '-R' to destroy the following datasets:
  | w2bz/c
(after: unchanged)

==================== (a3) the clone INSIDE the tree (w2bz/t/k = clone of w2bz/t/o@s): zfs destroy -r w2bz/t
$ zfs destroy -r w2bz/t
exit code: 0
stdout:
stderr:
zfs list -t all -r -o name,type,origin w2bz  (after):
  | w2bz	filesystem	-

==================== (b0) a zvol child with a snapshot: the sweep ANAS reads
before:
  | w2bz	filesystem	-
  | w2bz/t	filesystem	-
  | w2bz/t@s	snapshot	-
  | w2bz/t/a	filesystem	-
  | w2bz/t/a@s	snapshot	-
  | w2bz/t/v	volume	-
  | w2bz/t/v@s	snapshot	-
  | w2bz/t/z	filesystem	-
  | w2bz/t/z@s	snapshot	-
$ zfs list -H -t snapshot -r -o name -- w2bz/t
exit code: 0
stdout:
  | w2bz/t@s
  | w2bz/t/a@s
  | w2bz/t/v@s
  | w2bz/t/z@s
stderr:

==================== (b1) zfs destroy -r w2bz/t (zvol child w2bz/t/v with w2bz/t/v@s)
$ zfs destroy -r w2bz/t
exit code: 0
stdout:
stderr:
zfs list -t all -r -o name,type,origin w2bz  (after):
  | w2bz	filesystem	-

==================== (b2) the same with the zvol's snapshot HELD (zfs hold keep w2bz/t/v@s)
$ zfs holds -H w2bz/t@s w2bz/t/a@s w2bz/t/v@s w2bz/t/z@s
exit code: 0
stdout:
  | w2bz/t/v@s	keep	Fri Oct 16 05:41 2026
stderr:
$ zfs destroy -r w2bz/t
exit code: 1
stdout:
stderr:
  | cannot destroy snapshot w2bz/t/v@s: it's being held. Run 'zfs holds -r w2bz/t/v@s' to see holders.
  | cannot destroy 'w2bz/t': dataset already exists
zfs list -t all -r -o name,type,origin w2bz  (after):
  | w2bz	filesystem	-
  | w2bz/t	filesystem	-
  | w2bz/t/v	volume	-
  | w2bz/t/v@s	snapshot	-
```

**Answers.** (a) A clone origin outside the tree makes `zfs destroy -r` **ATOMIC**: libzfs walks the dependents before it
destroys anything and refuses with "filesystem has dependent clones / use '-R' …" naming the clone; nothing is destroyed,
and unlike a hold the dry run (`-rnv`) sees it too (exit 1, same text). A clone inside the tree is destroyed with it (a3).
(b) The sweep ANAS reads lists the zvol's snapshot (`w2bz/t/v@s`), and `zfs destroy -r` destroys the zvol and its
snapshot. A HELD zvol snapshot is **PARTIAL** exactly as wave 2 row 6 found for a filesystem: the siblings `w2bz/t/a`,
`w2bz/t/z` and the parent's `w2bz/t@s` went first, then it stopped (exit 1), with a second, misleading line ("dataset
already exists"). That is the case cr.47e's gate exists for.

### 1b. Through ANAS (`r1b-api-destroy.sh`, `out/r1b-api-destroy.log`)

```
A  clone origin outside the tree — DELETE /pools/w2bz/datasets/t?recursive=true
   409 CONFIRMATION_REQUIRED "Destroying dataset 'w2bz/t' permanently erases its data"
       warnings: "Destroying 'w2bz/t' is irreversible — all data in the dataset is permanently lost." / "4 child
       dataset(s) will also be destroyed." / "1 snapshot(s) of 'w2bz/t' will also be destroyed." / "Child datasets
       destroyed with it: w2bz/t/a, w2bz/t/o, w2bz/t/o/g, w2bz/t/z."          (no word about the clone w2bz/c)
   resend with x-anas-confirm: 0258c7a0b636 -> 202 zfs.destroy
   job failed at t+0 s: {"code":"JOB_FAILED","message":"cannot destroy 'w2bz/t': filesystem has dependent clones\nuse
       '-R' to destroy the following datasets:\nw2bz/c"}
   tree after: all twelve rows unchanged — nothing destroyed
B  zvol snapshot w2bz/t/v@s HELD — DELETE /pools/w2bz/datasets/t?recursive=true
   409 CONFLICT reason snapshot-held "A recursive destroy of 'w2bz/t' is refused: it would destroy held snapshots, and
       ZFS stops at a held snapshot only after destroying the unheld ones — nothing was done. w2bz/t/v@s held by 'keep'."
   the same with a made-up x-anas-confirm -> the same 409 (the gate answers before the confirm is looked at)
   tree after: unchanged
C  the same zvol tree, hold released -> 409 confirm ("3 child dataset(s)", "Child datasets destroyed with it: w2bz/t/a,
       w2bz/t/v, w2bz/t/z.") -> resend 202 -> completed {"destroyed":"w2bz/t"}; tree after: w2bz only
```

**Verdict: PROVEN** — cr.47e refuses 409 `snapshot-held` naming the held snapshot and its tag on a real zvol, before the
confirm, and nothing is destroyed; an unheld zvol tree destroys whole. The clone-origin case is **not** a partial destroy:
ZFS's own dependents check refuses before anything goes, so ANAS's job fails with nothing destroyed. No D<n>. What it
costs the operator is a confirm that says nothing about the clone and a failed job carrying the raw two-line ZFS text
(F3 below).

---

## Row 2 — cr.41b: systemd exit codes and the delete door

### 2a. systemd's answers (`r2-systemd-show.sh`, `out/r2-systemd-show.log`)

The daemon's strict read is `systemctl show <unit> -p ActiveState,InactiveExitTimestamp` with `TZ=UTC`
(`unit-run-status.ts` `showUnitPropsStrict`: a non-zero exit refuses). Each case: that argv, then `-p ActiveState`, then
`-p LoadState,LoadError` for context. Verbatim (the `-p ActiveState` lines are the same as the first and left out):

```
(i) a stored, loadable ANAS task unit
$ env TZ=UTC systemctl show anas-backup-w2bt1.service -p ActiveState,InactiveExitTimestamp
exit code: 0
stdout:
  | ActiveState=inactive
  | InactiveExitTimestamp=
$ systemctl show anas-backup-w2bt1.service -p LoadState,LoadError
exit code: 0
  | LoadState=loaded
  | LoadError=

(ii) unit files that exist but systemd cannot load (throwaway copies under /run/systemd/system)
  w2bbad-b  "[Service] Type=oneshot" (no ExecStart)        exit 0  ActiveState=inactive  InactiveExitTimestamp=
            LoadState=bad-setting
            LoadError=org.freedesktop.systemd1.BadUnitSetting "Unit w2bbad-b.service has a bad unit file setting."
            journal: "w2bbad-b.service: Service has no ExecStart=, ExecStop=, or SuccessAction=. Refusing."
  w2bbad-c  "[Service" (unterminated section header)        exit 0  ActiveState=inactive  InactiveExitTimestamp=
            LoadState=error
            LoadError=org.freedesktop.DBus.Error.InconsistentMessage "Unit w2bbad-c.service failed to load properly,
            please adjust/correct and reload service manager: Bad message"
            journal: "/run/systemd/system/w2bbad-c.service:1: Invalid section header '[Service'"
  w2bbad-e  a zero-byte file                                exit 0  ActiveState=inactive  LoadState=masked
            LoadError=org.freedesktop.systemd1.UnitMasked "Unit w2bbad-e.service is masked."
  w2bbad-f  a symlink to /dev/null                          exit 0  (the same as e: masked)
  w2bbad-a  "ExecStart=true" (relative)                     exit 0  LoadState=loaded  — systemd 257 accepts it
  w2bbad-d  "Type=w2bnope"                                  exit 0  LoadState=loaded  — "Failed to parse Type=w2bnope, ignoring"

(iii) a nonexistent unit
$ env TZ=UTC systemctl show anas-backup-w2bnope.service -p ActiveState,InactiveExitTimestamp
exit code: 0
stdout:
  | ActiveState=inactive
  | InactiveExitTimestamp=
  (LoadState=not-found, LoadError=org.freedesktop.systemd1.NoSuchUnit "Unit anas-backup-w2bnope.service not found.")

(iv) a template name with no instance
$ env TZ=UTC systemctl show anas-backup-@.service -p ActiveState,InactiveExitTimestamp
exit code: 1
stdout:
stderr:
  | Failed to get properties: Unit name anas-backup-@.service is neither a valid invocation ID nor unit name.
(w2bbad@.service: the same, exit 1)
```

**Answer to the brief's question.** systemd 257 answers `systemctl show` with **exit 0** for every unit that has a valid
name — loaded, bad-setting, error, masked, not-found — and exit 1 only for a name it cannot parse (a template with no
instance). A task's unit name is `anas-backup-<BackupName>.service` with `BackupName` = `^[a-z0-9][a-z0-9-]*$`, which can
never be such a name, so **a healthy stored unit is never refused `run-state-unreadable` on this systemd**; neither is a
broken one. The strict read refuses only when systemctl itself cannot answer (the bus or PID 1 unreachable, a spawn
failure). The brief's expectation that a (ii) unit gives the 409 does not hold on PVE 9 (c): systemd reads such a unit as
`inactive`, which is the truth (a unit that cannot load cannot be running).

### 2b. The door, live (`r2b-delete-door.sh`, `out/r2b-delete-door.log`; run 1 printed the list's names as `None` —
the reply nests `task.name` — script bug (b), kept as `out/r2b-delete-door-run1-scriptbug.log`)

```
A  w2bt2: ExecStart= removed by hand (LoadState=bad-setting, systemctl show exit 0), X-ANAS-Task intact
   GET /backup/tasks -> 200 ['w2bt1', 'w2bt2', 'w2bt3']     GET /backup/tasks/w2bt2 -> 200 (the task, nextRunAt 2030-01-01)
   DELETE /backup/tasks/w2bt2 -> 202 backup.task.remove -> completed {"removed":"w2bt2"}; both unit files gone
B  w2bt3: X-ANAS-Task hand-corrupted ({"name" -> {name), unit otherwise loadable
   GET /backup/tasks -> 200 ['w2bt1']   (anasd: "[backup] skipping anas-backup-w2bt3.service: no valid X-ANAS-Task JSON")
   GET /backup/tasks/w2bt3 -> 404 "Backup task 'w2bt3' not found"
   DELETE /backup/tasks/w2bt3 -> 202 -> completed {"removed":"w2bt3"}; anas-backup-w2bt3.service and .timer both gone
C  the fail-closed refusal, INJECTED: /usr/bin/systemctl bind-mounted by a wrapper that exits 1 ("Failed to get
   properties: injected by the w2b node pass", the stderr shape of case (iv)) for `show anas-backup-w2bt1.service …`
   and execs a copy of the real binary otherwise (`systemctl is-active anasd` through it: active, exit 0)
   DELETE /backup/tasks/w2bt1 -> 409 {"error":{"code":"CONFLICT","message":"Could not read Backup task 'w2bt1' run
       state from systemd — refusing to delete; nothing was deleted"}}     (no job submitted; both files kept)
   bind mount removed (sha256 of /usr/bin/systemctl = the copy, 848c70d7e2c2f43f) -> the same DELETE -> 202, removed
```

**Verdict: PROVEN** — a unit whose `X-ANAS-Task` no longer parses is omitted by the list and still removed (both files)
by DELETE; a unit systemd cannot load is deletable; the active-run gate refuses 409 with the "could not read … run state"
sentence when `systemctl show` fails, and only then. Two notes, no defect: the 409 carries no `reason` field (every other
guard refusal in this pass does: `snapshot-held`, `id-check-unreadable`; the brief's `run-state-unreadable` is a name
the code does not send — N2); and a task whose unit systemd refuses (case A) lists and reads as a healthy task with a
next run in 2030 — its timer would fire a unit that cannot start, which nothing on the task row says (N3).

---

## Row 3 — cr.33c: readAhrPools failure shapes

### Fixture (`r3-ahr-fixture.sh`, `out/r3-ahr-fixture-up.log`, `-down.log`)

Every AHR fixture script leaves the pool to the spec, and every ANAS create pins its arrays in `/etc/mdadm/mdadm.conf`
(`ahr-create.ts` `pinArrays`) and refreshes the initramfs, so no AHR pool may be created through ANAS in this pass. The
pool was therefore built by hand with the commands `ahr-create.ts` runs, minus the pin, the initramfs refresh and the
fstab line: two new 1 GiB hot disks (hot20, hot21), one GPT partition each, `mdadm --create /dev/md/w2bahr-r1
--level=1 --raid-devices=2 --metadata=1.2 --name=w2bahr-r1 --bitmap=internal --run`, `wipefs`, PV → VG `w2bahr` → LV
`w2bahr-vol` (every LVM call with `--config 'backup{backup=0 archive=0}'`), `mkfs.btrfs -L w2bahr -d single -m dup
--sectorsize 4096`, subvolumes `@data` + `@snapshots`, mounted `subvol=@data` at `/mnt/anas-ahr/w2bahr` by hand. ANAS
adopts it by its VG (ownership rule (a), "the matching LVM VG exists"): `GET /ahr` → `w2bahr`, `GET /ahr/w2bahr` 200
with both by-id members. `mdadm.conf` sha256 `b86d1edd…4c646fa1` before, during and after.

One node fact (c): ANAS's own read-only `vgs --reportformat json …` (from `GET /ahr`) wrote
`/etc/lvm/archive/w2bahr_00000-2146494517.vg` ("Created *before* executing '/usr/sbin/vgs …'"), because the hand-built VG's
create had skipped the metadata backup; the file was removed at teardown and the archive is back at 56 files.

### The three modes (`r3-ahr-unreadable.sh`, `out/r3-ahr-unreadable.log`; `r3c-logpoint.sh`, `out/r3c-logpoint.log`)

Backup task `w2bt4` on `/mnt/anas-ahr/w2bahr`, repo `w2bbh` (the blackholed 192.0.2.10: each direct run sits ~10 s in
proxmox-backup-client's connect and fails "client error (Connect)"; nothing reaches a PBS). Per mode: `GET /ahr`, `GET
/ahr/w2bahr`, the wizard's `POST /backup/tasks/preview-nested`, a direct run with anasd's LIVE lock table at t+3 s
(`held-locks.mjs`), and the run's first progress line through the logpoint at `dist/routes/backup.js:1083`
(`if (unlocked)`). That line is replaced within a millisecond (`r3b-progress-lines.sh`: back-to-back socket reads from
36 ms after submit never saw it), so the logpoint is the only way to read it.

```
R  readable (the real mdadm)
   GET /ahr 200 [w2bahr]; GET /ahr/w2bahr 200
   preview consistency: snapshot "/mnt/anas-ahr/w2bahr is on AHR pool 'w2bahr'; the run takes a read-only btrfs
       snapshot of @data (and of every nested subvolume it backs up) and backs up from it"
   locks held by the run: ahr:NyqTmR-dpxU-sNQ2-y1fC-iScS-r346-bapFbv, ahrname:w2bahr, mount:/mnt/anas-ahr/w2bahr,
       task:backup:w2bt4 (all shared)
   logpoint: {"unlocked":null,"sourceUnlocked":[]}
   progress: "archive 'w2bdata' <- /run/anas-ahr/w2bahr.toplevel/@snapshots/anas-backup-w2bt4-1792129645"
A  `mdadm --detail --export /dev/md127` EXITS 1 (wrapper: "mdadm: cannot open /dev/md127: injected …"; every other
   argv passes through — `--detail --export /dev/md/w2bahr-r1` through it still answered, exit 0)
   GET /ahr 200 []                       <- the live pool is gone
   GET /ahr/w2bahr 404 "AHR pool 'w2bahr' not found"
   preview consistency: live "/mnt/anas-ahr/w2bahr is on a btrfs filesystem (/dev/mapper/w2bahr-w2bahr--vol[/@data])
       that is not an ANAS AHR pool - ANAS does not snapshot filesystems it does not manage, so the backup is live"
   locks held by the run: mount:/mnt/anas-ahr/w2bahr, task:backup:w2bt4      (no ahr:, no ahrname:)
   logpoint: {"unlocked":null,"sourceUnlocked":[]}                            <- NO cr.33c sentence
   progress: "archive 'w2bdata': live - /mnt/anas-ahr/w2bahr is on a btrfs filesystem (…) that is not an ANAS AHR pool
       - ANAS does not snapshot filesystems it does not manage, so the backup is live"
B  /usr/sbin/mdadm NOT EXECUTABLE (a mode-0644 copy bind-mounted: spawn EACCES)
   GET /ahr 500 {"code":"EACCES","message":"spawn /usr/sbin/mdadm EACCES"}; GET /ahr/w2bahr the same 500
   preview consistency: live "/mnt/anas-ahr/w2bahr is on a btrfs filesystem (…) and the AHR topology could not be read,
       so it cannot be told whether it is an ANAS AHR pool - the backup is live"
   locks held by the run: mount:/mnt/anas-ahr/w2bahr, task:backup:w2bt4
   logpoint: {"unlocked":"/mnt/anas-ahr/w2bahr: no lock on the source - the AHR topology could not be read, so it is
       unknown whether the filesystem is an ANAS AHR pool", "sourceUnlocked":[that sentence]}
   progress: the consistency line above
R2 after both bind mounts were removed (mdadm sha256 bab911d1970826c6 = the copy): identical to R
```

**Answer.** A live pool reads as "no AHR pools" exactly when `mdadm --detail --export` answers with a non-zero exit (or
`cat /proc/mdstat` fails): `readAhrPools` never looks at the exit code — the empty detail matches no AHR name and the
array is skipped (`ahr-topology.ts:456-471`), so nothing throws, `ahrUnreadable` stays false, and every reader gets a
clean empty list. The backup run then carries **nothing**: no `ahr:` key, no cr.33c sentence, and a consistency line
that asserts the pool "is not an ANAS AHR pool". cr.33c's sentence appears only when mdadm cannot be spawned at all
(mode B), the one shape that throws. → **D12**.

**Verdict: FAILS (D12)** — cr.33c works for the failure shape that throws (B: the sentence on the run, the honest
consistency reason, a loud 500 on `GET /ahr`); the review's possible holds for the other shape (A): a live AHR pool
silently becomes "no AHR pools" and a backup of it runs live under a false sentence with no lock on the pool. The node was
restored exactly (row 5).

---

## Row 4 — the integration specs the last two passes could not run

`r4-specs.sh` runs each spec on its own (`npx playwright test --project=integration tests/integration/<spec>
--reporter=list`) from this worktree against the deployed node, with `ANAS_REQUIRE_FIXTURES=1` so a missing fixture
fails instead of skipping; one log per spec and round under `out/r4/`, one summary line per spec in
`out/r4/summary-<round>.txt`. Run 1 (06:05–06:39) is every spec as committed at `7ed186f`. Before it the node got
`testpool` back (hot1 + hot2 attached, `zpool import testpool` — the pool was on the images; no smb.conf or exports line
added) and the pvepool fixture (`pvepool-fixture.sh up`; wave 2 found its loops gone with the shut-off VM).

**Not run (5):** `smbsvc-api` and `ahr-cache-review` (the brief: mdadm.conf names `ahrpv`, `gtcache`); `ahr-cache-api` and
`ahr-cache-ui` (both create AHR pool `gtcache`, a name the brief forbids); `ahr-expand-zero-gain` (creates AHR pool
`gtexpand` through ANAS, and every ANAS AHR create pins its arrays in `/etc/mdadm/mdadm.conf` — an edit of the file the
brief says never to edit).

`task-status-reboot` reboots the node by design (boot −1 ended 06:39:19, boot 0 began 06:39:24); ADOCK's CT 9900
stayed stopped (onboot 0) and adock/adockd came back active.

| Spec | Run 1 (as committed) | Class | What was done | Final |
|---|---|---|---|---|
| 33 specs¹ | all passed | — | — | passed |
| backup-cancel | 1 failed, 1 not run: its PBS snapshot listing over ssh failed (PBS VM off); teardown "gtest untouched" | (c) | not run further: the spec starts a real backup to `pbsgt` and cancels it mid-upload, which writes chunks to the PBS the brief allows read-only | **not run** (brief) |
| backup-source-guard | 4 passed; test 5 "client error (Connect)" | (c) PBS VM off | not run further: test 5 writes a real snapshot to `pbsgt` | 4/5; test 5 **not run** (brief) |
| cloud-backends | 1 failed, 3 not run: `cloud-backends-fixture.sh up … smb` → "API post /identity/users answered 401: invalid csrf token" | (b) | not fixed (more than one line): the fixture's own curl client sends the PVE cookie and no `CSRFPreventionToken` — `api_ticket` keeps only the ticket and the mutate/job curls send no token header (`test/stunt-node/cloud-backends-fixture.sh:154-191`), so every mutation it makes is refused since cr.27 enforces CSRF in pveproxy (cr.25b moved the specs, not this script). Its `down` (the smb share and user it never made, the s3 unit it started) ran clean afterwards (`out/r5-cloud-backends-down.log`) | **not run** |
| cloud-cancel | 3 passed; test 4's teardown asserts the operator's remote `gtest` and task `testoff` survived | (c) | none: this node has no `gtest`/`testoff` (no cloud remote or task at the start of the pass). The spec's best-effort remote delete also left `gtcancelsftp` behind (swept through the API, `out/r4-leaks-after-run1.log`) | 3/4 (the 4th = (c)) |
| cloud-guided-viewer | test 1: strict-mode violation — `.x-btn` hasText 'Cancel' matched cr.48's hidden "Cancel test" button too | (a) | 3 lines → `getByRole('button', { name: 'Cancel', exact: true })` | 4/5 ×3 (runs 2–4); test 5 fails only on the teardown `gtest` assertion — (c) |
| cloud-remotes-ui | tests 4, 5 the same locator; 6, 7 cascaded | (a) | 3 lines, the same | 6/7, 7/7, 6/7 (runs 2–4); test 7 is **D14** |
| cloud-review-fixes | test 1 the same locator | (a) | 1 line, the same | 3/3 ×3 |
| cloud-tasks-ui | test 1: "the row lands selected" — the row is there, unselected (4/4 runs) | **D13** | one-line panel fix (below), redeployed | 8/8 ×3 (rounds d13-1..3) |
| ident-iscsi | `lio-not-installed` 409 | (c) | none: targetcli-fb / python3-rtslib-fb are not installed on this node (wave-2 table: "no targetcli-fb") | **not run** |
| identity-passdb | test 1 `toEqual` missing `uid: 1001`; after that fix, test 5 missing `groupRemoved: null` | (a) ×2 | cr.29 added `uid` to the create result and cr.29d `groupRemoved` to the delete result; one line each | 5/5 ×3 |
| pool-composer | "need >= 2 spare disks" | (c) | re-run with two new blank hot disks (hot3, hot16; `r4-extra-fixtures.sh`) | 2/2 |
| pools-act-api | 5 passed; 4 "no spare disks" | (c) | the same | 9/9 |
| pools-act-ui | 5 passed; 1 "no spare disks" | (c) | the same | 6/6 |
| pve-managed-pools | 3 × "datapool (PVE-managed) not present" | (c) | the spec header's recipe on a throwaway 1 GiB sparse-file pool (`zpool create datapool …; pvesm add zfspool datapool --pool datapool`), removed after | 3/3 |
| pvepool-api | 6 passed; tests 5–9 expect 400 VALIDATION_ERROR, get 409; test 11 `lio-not-installed` | (a) 5–9; (c) 11 | **not applied** (two lines each, status and code): cr.47 (a)(b) moved every owned-dataset door to 409 `PVE_MANAGED` with the SAME sentence — `out/r4-pvepool-refusals.log` has all five answers verbatim, e.g. `409 {"code":"PVE_MANAGED","message":"PVE storage 'pvfix' owns pvfix/vm-100-disk-0 as a guest volume","reason":"pve-managed"}`. The re-cut: `toBe(400)` → `toBe(409)` and `'VALIDATION_ERROR'` → `'PVE_MANAGED'` at lines 287/289, 304/306, 320/322, 337/339, 383/385. Test 9's failure leaked its accepted schedule `pvepool-proof` (swept through the API) | 6/12 |
| schedules-exclude-api | test 1 expects 400, gets 409 (message unchanged) | (a) | 1 line (the status) | 7/7 ×3 |

¹ alert-encoding 2, auth 4, cloud-backends-2 3, cloud-remotes-api 10, cloud-tasks-api 9, dashboard 2,
dataset-permissions 4, datasets-api 5, datasets-gfx-ui 3, datasets-hero 5, datasets-ui 5, disks-reprobe 5, gateway 7,
ident-mounts-repl 4, ident-zfs 5, pools-status 2, pve-login-flow 1, pve-native-ui 6, pvepool-ui 7, replication-ui 7,
sched-stamps 3, schedules-exclude 1, shares 8, share-users 3, smbsvc-recycle 5, smbsvc-ui 6, snapshots-api 3,
snapshots-ui 6, task-status-reboot 2, vdev-classes-api 3, vdev-consumers-api 3, vdev-remove-api 7,
vdev-remove-byid-api 6 — 33 specs, 152 tests, green on the first run.

### D13 — how it was found (`r4-cloud-tasks-ui-probe.diff`, `out/r4/cloud-tasks-ui-probe-run6..8.log`)

A temporary probe in the spec (never committed; the diff is kept) logged every `/cloud/tasks` and `/jobs` request, the
grid's selection every 50 ms, and page errors:

```
+4621ms REQ POST /cloud/tasks           +4780ms RES 202
+5285ms GET /jobs/b37cf262…  -> {"status":"completed","operation":"cloud.task.create",…}
+5375ms PAGEERROR TypeError: Cannot read properties of null (reading 'items')
          at ctor.down (ext-all.js) at setPreviewCancel (anas.js:48496) at abandonPreview (anas.js:48516) …
+9962ms REQ GET /cloud/tasks            <- the 10 s poll, not the create's reload
+10067ms SEL rows=1 sel=[]
```

cr.48 (`49a4125`) registered `win.on('destroy', function () { abandonPreview(win); })` on the task wizard
(`72-cloud.js:4418`) and on the toolbar Preview window (`:3876`); `abandonPreview` calls `setPreviewCancel`, whose
`win.down('#cloudPreviewCancel')` (`:3677`) ran OUTSIDE its try, and on `destroy` the window's items are already gone.
The TypeError escapes `win.close()` inside the create's `onComplete` (`:4513`), so `loadTasks(view, node, false,
body.name)` (`:4516`) never runs: after every Create (and every Edit save) the grid is not reloaded, the new row shows
up only with the next 10 s poll and is never selected; the Preview window's destroy handler stops before
`_releasePreviewBtn()`. **Severity: low-medium** (no data path; every save through the wizard looks like it did nothing
for up to 10 s, and the Preview button can stay held). **Fixed in this pass** (one line: the lookup moved inside the
try; `beca8df`), redeployed (`out/deploy-d13.log`; daemon/gateway dist unchanged, `out/dist-hashes-after-d13.log` still
`c4bb2d52…`; the node's `anas.js` carries the line), cloud-tasks-ui 8/8 three times after, `test:unit:ui` green.

### D14 — the save's failure alert is replaced by the reload's (`r4-cloud-remotes-ui-t7-probe.diff`, `out/r4/cloud-remotes-ui-t7-probe-{1,2,3}.log`)

cloud-remotes-ui test 7 (an injected failure before Save: `/etc/anas/rclone.conf` made a directory) failed in runs 2 and
4 and passed in run 3. A probe sampled the visible message boxes every 250 ms; three runs, the same each time:

```
+4319ms RES 500 PUT /cloud/remotes/gt {"statusCode":500,"code":"EISDIR","error":"Internal Server Error","message":"EISDIR: illegal operation on a directory, read"}
+4338ms MSGBOX Save failed — Internal Server Error
+4436ms RES 500 GET /cloud/remotes  (the reload the onFailed started)
+4528ms MSGBOX Load failed — Failed to load the rclone remotes: Internal Server Error     (from here on, only this)
```

`jobRejected` (`10-api.js:235-239`) calls `onFailed` (the remotes panel's reload) BEFORE `Ext.Msg.alert(failTitle, …)`,
and the reload's own failure alert (`72-cloud.js:390`, `ANAS.alertMsg`) lands ~100–250 ms later in the SAME singleton
`Ext.Msg` box and replaces it. The operator never gets to read the save's refusal; the spec sees it only when its poll
falls inside those ~100 ms. The spec's comment ("dismiss every stacked failure alert") assumes the two stack; with
`Ext.Msg` they cannot. **Severity: low** (only when the save and the reload both fail; the alert left still says
something is wrong). Not fixed (not a one-line change): the save's alert has to be raised before the reload, or the
reload's failure folded into it. The save's body is also Fastify's bare "Internal Server Error" (N4).

**Verdict: RUN, classified** — of 49 runnable specs: 41 green at the end (33 as committed; cloud-review-fixes,
identity-passdb, schedules-exclude-api after one-line re-cuts reproduced three times; cloud-tasks-ui after the D13 fix,
three times; pool-composer, pools-act-api, pools-act-ui, pve-managed-pools once their (c) fixtures existed); 5 partly
green (cloud-guided-viewer 4/5 and cloud-cancel 3/4 — the rest is a (c) teardown assertion; cloud-remotes-ui — D14;
backup-source-guard 4/5 — the 5th writes to PBS; pvepool-api 6/12 — (a) two-line re-cuts recorded, one (c)); 3 not run
(backup-cancel — PBS writes; cloud-backends — (b) fixture CSRF; ident-iscsi — LIO not installed).

---

## Findings

| # | Kind | What | Evidence | Where |
|---|---|---|---|---|
| **D12** | product defect, **medium** | A non-zero exit of `mdadm --detail --export /dev/mdX` (or a failed `cat /proc/mdstat`) makes a LIVE AHR pool read as "no AHR pools" with nothing thrown: `GET /ahr` → `[]`, `GET /ahr/<pool>` → 404, the members' disk rows read `status: "other"`, and a backup of the pool runs LIVE under a consistency sentence asserting the pool "is not an ANAS AHR pool", holding no `ahr:`/`ahrname:` key and carrying no cr.33c sentence. Only a spawn failure (EACCES) reaches cr.33c's `ahrUnreadable`. Bounded: the members are not offered as free disks (`other`, not available; `r3d-disks-mode-a.sh`). Fix shape: a non-zero `--detail` exit (and a failed mdstat read) throws, so every reader gets `ahrUnreadable`. | row 3 mode A | `packages/daemon/src/services/ahr-topology.ts:456-471` (`readAhrPools`: the mdstat failure returns `[]`; the `--detail` exit code is never read, an empty detail matches no AHR name and the array is skipped) |
| **D13** | product defect, low-medium — **fixed** (`beca8df`) | The cloud task wizard's and the Preview window's `destroy` handler threw (`win.down` on a destroyed window), so a created/edited task never reloaded or got selected and the Preview button release was skipped. | row 4 cloud-tasks-ui: 0/4 → 3/3 | `packages/pve-integration/src/72-cloud.js:3677` (cr.48's handlers at `:3876`, `:4418`) |
| **D14** | product defect, low | A save failure alert is replaced within ~0.1 s by the reload's own "Load failed" (one singleton `Ext.Msg`) when both fail. | row 4 cloud-remotes-ui test 7, three probe runs | `packages/pve-integration/src/10-api.js:235-239` (`onFailed` before the alert) with `72-cloud.js:390` |
| F3 | UX gap (not a partial) | A recursive destroy over a clone origin outside the tree is refused by ZFS before anything goes, but ANAS's confirm does not name the clone and the job fails with the raw two-line ZFS text. The sweep cr.47e already reads could carry it: `zfs list -H -t snapshot -r -o name,clones` names every dependent clone in the same call. | row 1 A | `packages/daemon/src/routes/datasets.ts:772` (`destroyHoldGate`), `parsers/zfs-list.ts:97` |
| N2 | note | cr.41b's fail-closed delete refusal carries no `reason` field, unlike the guard's other 409s; a client cannot tell it from any other CONFLICT. | row 2 C | `packages/daemon/src/services/task-units.ts:374` |
| N3 | note | A task whose unit systemd refuses to load (LoadState `bad-setting`) lists and reads as a healthy task with its next run in 2030; its timer would fire a unit that cannot start. | row 2 A | the task list/status readers |
| N4 | note | A remotes store that is a directory (`EISDIR`) answers the remotes PUT/GET with Fastify's bare 500 "Internal Server Error", no sentence. | D14 probe | the cloud remotes store read |
| N5 | node fact | LVM 2.03.31 writes `/etc/lvm/archive/<vg>_NNNNN.vg` before a READ (`vgs --reportformat json …`, from ANAS's own `GET /ahr`) and before udev's `vgchange -aay --autoactivation event`, when the VG's last metadata change was not backed up (the hand-built pool's create ran with backups off). The four `w2bahr_*` files were removed; the archive is back at 56. | row 3 | — |
| N6 | node fact | `pvesm add` / `pvesm remove` rewrite `/etc/pve/storage.cfg` in PVE's own form: after adding and removing the throwaway `datapool` the same four storages remain, but the sha256 went `4148f849…` → `7fca764c…` (the pre-pass hash was not recorded; the brief's table does not list the file). | row 4 | — |

Brief-vs-node notes: row 2's expectation that a unit systemd cannot load gets the 409 does not hold on systemd 257 (every
valid unit name answers `show` with exit 0); the 409 was proven by injecting the failure. Row 3's first progress line
cannot be read by polling (it is replaced within a millisecond), so it was read with a logpoint.

---

## Row 5 — node state at the start and the end of the pass

`out/node-state-start.log`, `out/node-state-end.log` (`node-state.sh`: wave 2's, plus `pct status` and a dataset count).

| Item | Start (05:37) | End (08:04) |
|---|---|---|
| ADOCK | CT 9900 `ingress-default` stopped, protection 1, onboot 0, tags `adock;adock-ingress;adock-net-default`, the same description; adock/adockd active; `/adock/` 401 | same (through task-status-reboot's reboot at 06:39: the CT stayed stopped, both units came back active) |
| `/etc/mdadm/mdadm.conf` | sha256 `b86d1eddd7fc3619d0a7608bc4010fe603578894ec305e017036d45e4c646fa1`, 2 ARRAY lines (`gtcache-r1`, `ahrpv-r1`) | identical — never edited; no AHR pool created through ANAS; the hand-built `w2bahr` never touched it |
| `/etc/lvm/archive` | 56 files | 56 (the four `w2bahr_*` archives LVM wrote in row 3 removed, N5); `/etc/lvm/backup` empty both times |
| failed units | `zfs-import@anasactimport`, `zfs-import@anascomp` | same |
| hot disks | none (sda system, sr0) | none — hot1/hot2 (testpool), hot3/hot16 (spares), hot20/hot21 (`w2bahr`, twice) attached and detached; the four new images (hot3, hot16, hot20, hot21) deleted |
| pools | gtbackup, gtiscsi ONLINE | same (testpool, pvfix, sysfix imported for row 4 and exported again, the pvepool loops detached; `w2bz`, `datapool` and `w2bahr` created and destroyed) |
| `/etc/fstab`, `/etc/exports`, `smb.conf` | `b3c85fb4`, `f1e3ca20`, `46779719` | same |
| `/etc/pve/user.cfg` | `ed65c582` (root@pam only) | same |
| `/etc/pve/storage.cfg` | (not recorded) pvfix, local, pvfixdump, sysfix-data | the same four storages, rewritten by `pvesm` (N6) |
| `AnyEvent.pm`, `AnasProxy.pm` | `0aad1102`, `c6beac85` | same |
| `index.html.tpl` | `d563d1a2` | `0637b14f` (bundle token re-stamped by the D13 redeploy) |
| share-band accounts | debian (1000) | debian (1000) |
| nft tables / NFS mounts / md / dm / loops / VGs | none | none (`inet w2bbh` removed) |
| `/etc/anas/rclone.conf` | 0 bytes | 0 bytes |
| backup repos / tasks / schedules / cloud remotes / cloud tasks | `pbsgt` / none / none / none / none | same (`w2bbh`, `w2bt1..4`, and the leaked `pvepool-proof` and `gtcancelsftp`, removed through the API) |
| `w2b*` objects, `/var/tmp/w2b`, bind mounts | — | none; `/usr/bin/systemctl` and `/usr/sbin/mdadm` sha256 equal the copies taken before each bind mount; the V8 inspector closed with the 06:39 reboot |
| anasd / anas / pveproxy | 2532 / 28450 / 1412 (wave 2's) | 81382 / 81384 / 1676 (the D13 redeploy after the reboot); NRestarts 0; `/v1/health` abandonedCommands `[]` |
| PBS VM anas-pbs | shut off | shut off (never booted) |
| stunt node VM | running the wave-2 build `455ff82` | running `beca8df` (= `7ed186f` + the D13 one-line panel fix) |

**Verdict: CLEAN.**

## Summary

| Row | Verdict | One line |
|---|---|---|
| R0 deploy | PROVEN | `7ed186f` deployed; 2204 dist files identical host vs node (again after the D13 redeploy) |
| 1 cr.47e / 47(c) | PROVEN | a held ZVOL snapshot → 409 `snapshot-held` naming it, before the confirm, nothing destroyed; an unheld zvol tree destroyed whole; a clone origin outside the tree is ATOMIC in ZFS (refused before anything goes, `-rnv` sees it too), so ANAS's job fails with nothing destroyed — no D (F3) |
| 2 cr.41b | PROVEN | systemd 257 `show` exits 0 for loaded/bad-setting/error/masked/not-found units and 1 only for an invalid name — a stored unit is never refused; a corrupted `X-ANAS-Task` unit is omitted by the list and DELETE 202 removes both files; the 409 "could not read … run state" when `show` fails (injected) |
| 3 cr.33c | FAILS (D12) | the sentence appears only when mdadm cannot be spawned; a `--detail` that exits non-zero turns a live pool into "no AHR pools" and its backup runs live under a false "not an ANAS AHR pool", with no lock and no sentence |
| 4 specs | RUN, classified | 41/49 green at the end (33 as committed); D13 found and fixed (one line), D14 recorded; one-line (a) re-cuts in five specs ×3; the rest (c) fixtures, PBS writes or LIO, one (b) fixture CSRF, pvepool-api's two-line re-cuts recorded |
| 5 node state | CLEAN | mdadm.conf, LVM archive, failed units, ADOCK, hot disks, pools, configs as at the start |
