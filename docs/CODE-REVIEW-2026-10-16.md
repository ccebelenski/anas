# Whole-project code review — 2026-10-16 (0.4.4 release candidate)

**Status:** read-only review at main `eeda9fc` (the 0.4.4 release candidate: 158 commits and
396 source files, +54k/−6.5k, since the 2026-10-14 review at `026bf64`), operator-ordered.
Nothing here is fixed by this document; it is the evidence for the stories cut from it. Scope: the
whole repository — daemon, gateway, shared schemas, PVE integration (ExtJS panels, the Perl hook
`AnasProxy.pm`, installers), packaging, CI, governing docs — with two things only a full read can
see: the **seams between the 0.4.4 stories** (the guard framework as every mutation route uses it,
the authorization hand-off end to end, the secret mask at every boundary, the identity mirror, the
AHR topology and cache heal, partition attach/replace, recursive walks and the findmnt readers),
and **regressions** (every §6 item and every C/H fix of the 2026-10-14 review re-checked at the
line). Paths are relative to `packages/daemon/src` unless they start with another top-level
directory or `shared/` (= `packages/shared/src/`).

**Evidence levels.** **[V]** = re-read in the code by the reviewer after the finding was raised
(file:line confirmed). **[R]** = reported with file:line by a scoped review pass, not
independently re-verified; treat as a strong lead and confirm before fixing. **(uncertain)** =
the reviewer doubts it. A finding confirmed by running something (a probe over the fake executor,
a unit test, a read-only command on the stunt node) carries the run's result in one line.

**Baseline.** `npm run -s test:unit` is green on this build: shared 230/230, daemon 6332/6332,
gateway 103/103, UI harnesses (2390 dialog-contract checks), shell suites all PASS, perl 176/176, no
skipped or todo; `typecheck` and `eslint .` clean. Every finding below is a gap the suites do not
exercise, not a red test.

**Attacker model.** As the brief sets it: any PVE login holding `Sys.Modify` on `/` for mutations,
`Sys.Audit` for reads. Fact that scopes it (`pveum role list` on the stunt node): of PVE's built-in
roles only `Administrator` holds `Sys.Modify`, and it also holds `Sys.Console` (a root shell), so a
built-in Administrator gains nothing from a Sys.Modify-to-root path. The exposed population is a
CUSTOM role carrying `Sys.Modify` without `Sys.Console` — which is what an operator reading the
0.4.4 release note ("changing anything … needs `Sys.Modify` on `/`") would build for a storage
operator. H4 asks for the ruling this implies.

**How this review ran.** Nine scoped passes (guard seams, authorization, secrets, identity, AHR and
partitions, walks/mounts/findmnt, regressions, input surfaces, UI/packaging/CI/docs), each told to
construct the hostile input and run it over the real routes and the fake executor; every finding
marked [V] was then re-read at the cited line by the reviewer, and C1 and H4's two share/export doors
were re-run end to end through the real routes by the reviewer. Probe sources are in the
review worktree's untracked `t/` and are named per finding; nothing was run against the node beyond
read-only commands.

---

## 1. Critical — authenticated (Sys.Modify) user to root code execution

**C1. Snapshot-schedule `name` reaches two systemd unit files unescaped — a newline injects an
`ExecStartPre=` directive the daemon then runs as root (ruling (i) gap; present since Epic 17,
missed by the 2026-10-14 review). [V]**
`SnapshotSchedule.name` is a bare `z.string().min(1)` (`shared/schemas/schedules.ts:105`), while
every sibling task name is a restricted slug (`BackupName`, `ReplicationTaskName`,
`CloudSyncTask.name = BackupName`). The schedule name is interpolated verbatim into
`Description=ANAS snapshot schedule ${schedule.name}` in BOTH the service and timer units
(`services/snapshot-schedule-units.ts:124, 139`), which `writeScheduleUnits` writes and then
`systemctl daemon-reload` + `enable --now`s (`:242-250`). The replication writer defends its
ExecStart with `quoteExecArg` throwing on `\n`/`\r` (`services/replication-units.ts:124-130`); the
snapshot writer has no such guard, and `Description=` is written before the embedded-JSON comment
and the real `[Service]` block, so a name containing a newline begins new `[Service]`/directive
lines that systemd merges with the real section; the injected `ExecStartPre=` runs as root before
the real `ExecStart` the first time the timer fires. Run end to end through the real route (`t/v/sched-name.test.ts`, headers
`alice@pve` + `Sys.Modify` only): `POST /v1/schedules {"id":"evil","name":"x\n[Service]\nExecStartPre=/bin/touch /root/pwned",…}`
→ 202, and the written `anas-snap-evil.service` reads `[Unit]\nDescription=ANAS snapshot schedule
x\n[Service]\nExecStartPre=/bin/touch /root/pwned\n# X-ANAS-Schedule=…\n\n[Service]\nType=oneshot…`
(systemd merges repeated `[Service]` sections). The timer is enabled at once; a `frequently` cadence
fires within the quarter hour (Run Now runs in the daemon, not through the unit, so it does not
trigger it). Same class as the 2026-10-14 C1 ssh-option injection: any PVE login with `Sys.Modify` on
`/` reaches root command execution. The AHR scrub writer has the same unescaped-Description shape
but `AhrScrubSchedule` carries no free-text name, so it is not reachable today.
**Fix:** `SnapshotSchedule.name` = `SingleLine` (no control chars) at the schema, AND the snapshot
unit writer refuses a newline in every interpolated field (mirror replication's `quoteExecArg`); a
unit-rendering test asserts an injected name cannot add a directive.

## 2. High

**H1. Only the remote-mount door refuses system paths, and only lexically: a ZFS pool, a dataset
or an AHR pool can be mounted over `/etc` or `/usr/bin` — the dataset door with no confirm at all
(2026-10-14 M7 residue; cr.18 × cr.23 seam). [V]**
`systemMountTargetConflict` is called at one place, `routes/mounts.ts:412`. Pool create passes
`-m req.mountpoint` (`routes/pools.ts:536-537`) with collision gates only; pool mountpoint change
refuses only `/` and `/mnt/pve` (`routes/pools.ts:1908-1914`, then a confirm); dataset create puts
`-o mountpoint=` straight into argv (`routes/datasets.ts:101-102`; schema plain `AbsolutePath`,
`shared/schemas/datasets.ts:229`); AHR create/mountpoint refuse only `/` and `/mnt/pve`
(`routes/ahr-mutate.ts:635-638, 709-712`). OpenZFS 2.4.4 on the stunt node has `overlay=on` by
default, so a dataset mounts over a non-empty `/etc`. The remote-mount door's list deliberately
allows everything under `/root`, `/var`, `/home` (`services/mounts.ts:1519-1526`, so
`/root/.ssh`, `/var/spool/cron/crontabs` pass), and never resolves symlinks: `dirContents` follows
the link (`routes/mounts.ts:1325-1334`), `mkdir` is recursive (`:593`), `mount` runs without `-c`
(`:1081-1084`) so mount(8) canonicalises a planted `x -> /etc`. Probe (`t/f/probe1.test.ts`, real
routes over the fake executor): `POST /v1/pools {mountpoint:"/etc"}` → 202, `zpool create -o
autoexpand=on -m /etc -- newpool …`; `POST …/datasets {path:"evil",properties:{mountpoint:"/usr/bin"}}`
→ 202, `zfs create -o mountpoint=/usr/bin -- testpool/evil`; `PUT …/pools/testpool/mountpoint
{"/etc"}` → 409 confirm (not a refusal); `POST /v1/mounts {mountpoint:"/root/.ssh"}` → 202.
Two readings, both real: an operator's typo in the dataset dialog hides `/usr/bin` and the node
stops working (no confirm stands between); and a Sys.Modify holder who stages a `shadow` or
`authorized_keys` on a pool through a share then moves the pool's mountpoint over `/etc` or
`/root/.ssh` is root (see H4 for when that matters).
**Fix:** one shared `mountTargetRefusal(path)` (the cr.18 list plus credential/login trees:
`/root`, `/home/*/.ssh`, `/var/spool/cron`, …; realpath the parent, lstat-refuse a symlinked final
component) asked at every door that sets a mountpoint — remote mount, pool create/mountpoint,
dataset create and property set, AHR create/mountpoint — at route and job; the mount job runs
`mount -c` on the resolved path.

**H2. The nf.1 recursive-permission walk is path-based `find … -exec <tool> {} +`; a user who
can create symlinks inside the tree can redirect a root `setfacl`/`chmod` outside it. [V]**
`services/access-walk.ts:143-152` builds `find -P <root> -xdev … ! -type l -exec setfacl -b -m
<spec> {} +` (and `chmod`, `chmod g+s`, `chown -h` the same way; run from `services/access.ts:1060,
1093, 1111, 1127, 1150, 1168, 1195`). `! -type l` is decided when `find` lists the path; the batch
runs later on full paths, so a directory swapped for a symlink in between is traversed by the
kernel, and `setfacl -m`/`chmod` follow a symlinked final component. Scenario: an NFS client (or a
local account) with write access under a share watches ctime, then swaps `share/d` for
`d -> /etc` containing names `shadow`, `sudoers`; the admin's recursive apply with a named grant
`u:<user>:rwX` lands on `/etc/shadow`. Local simulation (`t/f/race.sh`, swap between listing and
exec): `victim/secret` went 600 → 644 through the symlinked directory. The walk exists so the
apply stops at mount boundaries (the release note's "Partitions and ownership" fix); whether the
`-R` tools it replaced were race-free is not proven here (uncertain — coreutils' fts is
fd-relative). Tools on the node support the safe form: chmod 9.7 `-h`, setfacl 2.3.2 `-P`, find
`-execdir`.
**Fix:** every walk action via `-execdir` with no-follow on the final component (`chmod -h`,
`chown -h`, `setfacl -P`), so each batch runs relative to a directory fd find opened.

**H3. The PBS file restore and new-LUN image restore never moved onto the guard: their confirms
do not bind what changes the blast radius, and file restore re-checks nothing when its turn comes
(2026-10-14 M3 + H8 residue; ruling (j)). [V]**
The new-LUN image restore signs `{target, lun, mode}` only (`routes/backup.ts:2330-2332`) —
snapshot, archive, namespace and the backing kind/pool are unsigned. File restore signs
`{target, snapshot, archive, mode}` (`:2565`, `:2656`) — `selections`, `repo`, `ns` and `options`
are unsigned; the in-place image restore's confirm (`:2063`) does not bind `ns`. File restore is
submitted with `{ lane: 'long' }` only (`:2728`): no `guarded` re-read, no lock claims; every
pre-flight (PVE territory, held-by-LUN, existing directory, writable, space, `:2512-2620`) runs at
the request only, while the long lane can hold it for hours behind three data movers. Probes
(`t/a/probe-newlun.test.ts`, `t/a/probe-restore-files.test.ts`, real routes over the fake executor):
a code minted for `archive: vol.img` accepted a resend with `archive: lun.img` → 202, argv
`["restore","host/gtimgboth/…","lun.img","-","--ns","gtrestore"]`; a code minted for an in-place
restore of `/docs` accepted `selections: ['/docs','/etc']` → 202, argv `… --pattern /docs --pattern
/etc --allow-existing-dirs --overwrite`. WAVE3-DESIGN listed exactly these gaps
(`docs/WAVE3-DESIGN.md:237-238, 466-467`: "selections unbound", job re-check "nothing"); no story
took them (cr.40 covered the in-place image restore only). The release note's "Every operation …
checks again when its turn comes" is false for this verb, the one that runs `--overwrite` into live
data. A destroy, rollback or unmount of the destination is not serialised against it either.
Its PVE-territory pre-flight also fails OPEN: `readPveMountPaths(…).catch(() => new Map())`
(`:2521`) — an unreadable `storage.cfg` admits a restore into PVE's storage, against the release
note's "a storage configuration that cannot be read says so instead".
**Fix:** move file restore and new-LUN restore onto `guardCheck`/`guardConfirm` with the whole
validated request signed; re-run the pre-flights in the job through the same spec; shared claims on
the destination's `zfs:`/`ahr:`/`mount:` keys from `pathSourceClaims`.

**H4. Through ANAS, `Sys.Modify` on `/` is root on the node — by several designed doors, not
one bug; the 2026-10-14 authorization ruling needs its consequence written down (operator
ruling). [V]**
The 0.4.4 release note says "changing anything … needs `Sys.Modify` on `/`" as if it were a bound.
It is not: "a path is a path" (§2 Shares) lets a Sys.Modify holder share `/etc` with a grant, or
export `/` read-write without root squash, and H1 moves a pool over `/etc`. Probe
(`t/v/share-etc.test.ts`, headers `alice@pve` + `Sys.Modify` only): `POST /v1/shares/smb
{name:"etcs",path:"/etc",validUsers:["shareuser"],grantAccess:{}}` → 202, job completed
`{"created":"etcs"}` (the grant step refused only because the fake cannot stat `/etc`; on a node it
writes `u:shareuser:rwx` on `/etc`); `POST /v1/shares/nfs {path:"/",clients:[{spec:"*",options:
["rw","no_root_squash"]}]}` → 202, completed `{"created":"/"}`, `exportfs -ra`. On the stunt
node's built-in roles only `Administrator` holds `Sys.Modify`, and it also holds `Sys.Console`
(`pveum role list`), so built-in roles gain nothing; a CUSTOM role with `Sys.Modify` and no
`Sys.Console` — exactly what an operator would build for a "storage operator" after reading the
release note — is escalated to root.
**Fix:** the operator rules one of two: (a) Sys.Modify through ANAS is root-equivalent — say so in
§2 "Authorization follows PVE", DESIGN's Authorization section and the release note ("grant it only
where you would grant Sys.Console"); or (b) it is not — then a system-path refusal (H1's helper)
at every path door: share and export paths, `no_root_squash`/`insecure` on a world spec, file-restore
targets (their only path refusals are PVE territory and a LUN backing, `routes/backup.ts:2515-2530`;
`/etc` passes), the access editor. (a) is one paragraph and true
today; (b) is a story.

## 3. Medium

**M1. Cloud sync preview and run never mask: a saved remote's credential echoed by rclone
reaches the job record, the notification e-mail and the unit journal (cr.48b/cr.48f residue). [V]**
cr.48f closed the saved-remote blind spot for the remote Test only (`savedSectionPlainSecrets` →
mask, `services/rclone-probe.ts:388-416, 472`). The preview masks with `deps.secrets`
(`services/cloud-preview.ts:211, 227, 237`), but the route builds `deps = { task, paths, fstabPath }`
(`routes/cloud.ts:912`, used at `:941`) — the mask runs over an empty list; its unit test passes
secrets in directly (`services/__tests__/cloud-preview.test.ts:349`), which hides the gap. The run
has no mask at all by design (`services/cloud-runner.ts:766-771`: "There are none in a cloud sync
run"): rclone's error lines become `rcloneFailureMessage` (`:717-730`) → `job.error`, the run
detail's `recent` ring, `notifyCloudRun`, and `cloud-task.ts:127` writes it to the journal that the
status reads back (`services/cloud-units.ts:418`). Probe (`t/c/cloud-leak.test.ts`, saved s3 remote
with `secret_access_key = Sup3rS3cretValue42`, rclone stderr quoting it): Test → `…bad credential
[secret]`; Preview → `errors:["a.bin: … bad credential Sup3rS3cretValue42"]`; run → `job.error
"rclone copy failed (exit 1): a.bin: … Sup3rS3cretValue42"`; the notify call carries it. The
release note "Secrets stay out of replies" and EPICS cr.48b–e ("every pbc and rclone output that
leaves the daemon … is masked") are false for these two doors.
**Fix:** one helper builds a remote's secret list (saved plain + obscured values, transitively over
wrapped remotes); preview and run pass it and mask `errorLines`, `recent` and the failure message
where they are made; add a route-level test.

**M2. Data-mover and schedule runs take their lock claims from the route's read but act on the
job's re-read: an edit landing in between makes the job work on an object it holds no key for
(cr.33 × cr.41 seam). [V]**
Backup direct run: claims from `sourceTask` read at the route (`routes/backup.ts:1375-1378`), the
body re-reads the task and backs up its paths (`:1412`); the comment admits it ("a task edited in
between is cr.41's — its claims are the ones read now"). Cloud: same split (`routes/cloud.ts:1138`
vs `:1169`). Schedule fire: claims from the route-read target (`routes/schedules.ts:323-328`); the
job re-reads the schedule, but its bound id is the schedule id only (`:318`), so a changed target
passes. Scenario: a timer fire queued behind an operator's update (the update holds the task/
schedule key exclusive, the fire shared, FIFO) runs after it — it snapshots and prunes, or backs
up, the NEW target while holding keys on the old one; a destroy or rollback of the new target is
not serialised against it — the release note's "a data mover holds its source for the run" fails
in exactly the edit case.
**Fix:** bind the claim-bearing fields (archive paths, schedule target) as the spec's `revision` so
a changed object refuses `STATE_CHANGED`; or recompute the claims in the job and refuse when they
differ from the held set.

**M3. An AHR slice can be taken as a ZFS leaf, and an AHR resume then writes md over it — the
two partition doors do not see each other's labels (seam nf.1 × AHR expand). [V]**
The ZFS partition gate (`routes/pools.ts:843-893`) asks `blkidContentSignatures`, which drops every
`PART_ENTRY_*` key (`services/partition-device.ts:98-104`) — including `PART_ENTRY_NAME`, where
the AHR GPT label (`<pool>-dN-bM`, `<pool>-cacheN`) lives — so a blank AHR slice reads "blank". An
expansion halted after cutting its slices but before md wrote them leaves exactly such slices, a
shape the resume allows (`services/ahr-expand-resume.ts:56-79`, "or there is none yet"). On Resume,
`halfJoinedProblem` → `classifyPartition` reads only md superblocks
(`services/ahr-identity.ts:288-296`), so a slice now carrying a ZFS label reads `blank`, not
`foreign`, and the resume proceeds to `mdadm --add` (busy while the ZFS pool is imported; overwrites
the ZFS leaf if it is exported). Probe (`t/e/probe-ahr-slice.test.ts`, the nf.1 attach test with
`PART_ENTRY_NAME="tank-d3-b2"` on the blank `blkid -p` line): 202, job completed
`zpool replace -- gtvdev …HOT9-part2 …HOT9-part4`.
**Fix:** the ZFS partition gate refuses a partition whose `PART_ENTRY_NAME` matches an AHR member
or cache label; `classifyPartition`/`halfJoinedProblem` treat any non-md content signature from
`blkid -p` as `foreign`.

**M4. Identity jobs and gates still read the Samba passdb fail-open: a transient `pdbedit`
failure skips `smbpasswd -d`, skips `pdbedit -x` before `userdel`, and lets a password overwrite
another account's entry (2026-10-14 M7 residue). [V]**
`smbEntries()` returns `[]` on any read failure (`routes/share-identity.ts:306-312`, by design for
the list GETs, issue #6). It is also the read behind the guard's `passdb` fact (`:479`), so
`passdbNotOwnedGate` (`:661-670`) and the create's passdb gate (`:1446-1460`) pass when the passdb
cannot be read; the enable/disable job (`:1650`) and the delete job (`:1861`) use it too.
Scenario (`pdbedit -L` exits 1 "tdb locked" once, fake executor, probe `t/d/probe-identity.test.ts`):
disable completes `{"enabled":false}` with only `usermod --expiredate 1` — SMB stays live on a
user the panel shows locked; delete completes `{"smbEntryRemoved":false}` after the confirm
promised removal, and runs `userdel`, leaving an orphan entry under the same name (which then
feeds M5); `POST …/smb-password` for `Name` while the folded entry `name` belongs to uid 1005
runs `smbpasswd -a -s Name` — uid 1005's SMB password is overwritten before the post-write verify
refuses.
**Fix:** gates and jobs read the passdb strictly (`readPassdb()`; 503 / failed job with a sentence
when unreadable); skip the SMB step only when `smbAvailable()` is false; the fail-open read stays
for list GETs only.

**M5. A new user created over a SAME-case orphan passdb entry inherits the old account's SMB
password (2026-10-14 M6 #24, still open). [V]**
The create refuses an orphan only when `existing.stored !== s.name` (`routes/share-identity.ts:1454`),
so an exact-case orphan with no `smbPassword` in the request passes. Probe: passdb holds
`Name:4294967295:`; `POST /identity/users {"name":"Name"}` → 202, `useradd … -u 1002 Name`, no
`pdbedit -x`; the entry now maps to the new account with the old hash. M4's delete path
manufactures exactly this state. `docs/IDENTITY-AUDIT-2026-10-06.md:132` still carries no status
for #24.
**Fix:** any folded entry whose uid resolves to no account is an orphan whatever its case — refuse
the create (or `pdbedit -x` it in the job, under the same gate).

**M6. A picked uid/gid can still inherit a deleted account's ACL grants, which the §2 ruling
forbids (2026-10-14 M6 #25 residue). [V]**
EPICS §2 "Shares & identities" (`docs/EPICS.md:105`): "a deleted id must never be handed to a new
user … inherit every file and ACL grant". The pick (`services/identity-ids.ts:439-476`) skips ids
that OWN files (`zfs userspace|groupspace` per filesystem, bounded `find -uid` on non-ZFS share
roots, header `:36-50`); nothing in the module reads ACL entries. Scenario: alice (uid 1005, top of
the band) is granted `u:alice:r-x` + default ACL on `/tank/finance` through the access editor and
never writes a file; delete alice; create bob → the pick starts at 1005, which owns nothing, and
bob reads finance.
**Fix:** add `getfacl -n -p` access + default entries at the managed roots (share/export paths and
the access editor's roots, bounded like the ownership walk) to the pick's skip set, or narrow the
§2 ruling and the cr.29 claim to "owns no files".

**M7. A CIFS `pass=` option, or `PASSWORD=` in upper case, in a hand-written fstab line is
returned in plain text by `GET /mounts/:mp` (any Sys.Audit reader). [V]**
`classifyOptions` lifts only the exact keys `username`/`password` into `inlineCredentials`
(`parsers/fstab.ts:693-700`); everything else is `passthrough`, which the response keeps
(`services/mounts.ts:1295`); `redactFstabLine` matches `password=` only (`:1274, 1285`, case-
insensitive). mount.cifs(8) documents `password=arg|pass=arg` (cifs-utils 2:7.4-1 on the stunt
node), and cr.2's write side already refuses `pass`/`user` as credential tokens, so read and write
disagree. Probe (`t/c/fstab-pass.test.ts`): `//nas/share /mnt/s cifs user=bob,pass=Hunter2xyz,vers=3.0
0 0` → `fstabLine` unchanged and `options.passthrough` `"user=bob,pass=Hunter2xyz"`; with
`PASSWORD=Hunter2xyz`, `fstabLine` is redacted but `passthrough` is `"PASSWORD=Hunter2xyz"`.
**Fix:** one shared credential-key list (`password|pass|password2`; `user|username`,
`domain|dom|workgroup` as metadata), case-insensitive, used by the reader, `redactFstabLine` and
cr.2's refusal.

**M8. The udev cache-event script logs a refused event as delivered, and the boot rung's skip
notifies nobody — an unattended cache-SSD failure can go unreported. [V]**
`packaging/anas-cache-event.sh:117-124` runs `curl --silent --show-error` without `--fail`, so any
HTTP answer (409, 500, 503) exits 0 and logs `EVENT=CacheEventDelivered` (run: curl against a local
server answering 501 exited 0). Scenario: the cache SSD dies while the AHR topology is unreadable
(the ahr.r1 rider shape) → the route answers an error, the journal says Delivered, the pool keeps
returning EIO; at the next daemon start the boot rung skips with a log line only
(`services/ahr-boot-scan.ts:286-290`, `cache-rung=skipped reason=topology-unreadable`) and sends no
PVE notification.
**Fix:** `--fail` (or check `%{http_code}`) and log `CacheEventUndelivered REASON=http-<code>`; the
boot rung's topology-unreadable skip calls `notifyCacheRecoveryFailed` when `cachedVgNames` is
non-empty.

**M9. Uninstall leaves every cloud-sync task's timer firing a runner it has just deleted. [V]**
`remove_schedule_units` loops over `anas-snap anas-backup anas-repl` (`packaging/uninstall.sh:44`)
plus `anas-scrub`/`anas-recycle`; cloud tasks are `anas-cloud-<name>` units
(`services/cloud-units.ts:72`) whose ExecStart is `/opt/anas/packages/daemon/dist/cloud-task.js`
(`:71`), and step 4 is `rm -rf /opt/anas` (`uninstall.sh:269`). The function's own header
(`:23-30`) names this failure mode as the reason the other families are removed; the test
(`packaging/test/uninstall-schedules.test.sh`) has no cloud case. Scenario: uninstall a node with
one scheduled cloud task — its `Persistent=true` timer fails on every cadence forever. Present since
rclone.2 (0.4.0); the 2026-10-14 review missed it.
**Fix:** add `anas-cloud` to the family loop and a cloud case to `uninstall-schedules.test.sh`.

## 4. Low
- **L1. Group membership edits gate the group's gid, never the member's uid — system accounts can be
  added to share groups (2026-10-14 C3 residue). [V]** `groupGuardSpec` 'members'
  (`routes/share-identity.ts:891-894`) runs local, band (gid) and `membersResolveGate` (`:772-780`,
  resolves names only). Probe: `PUT /identity/groups/media/members {"add":["root","www-data"]}` →
  `gpasswd -a root media`, `gpasswd -a www-data media`; www-data is pveproxy's user. **Fix:**
  `membersResolveGate` refuses an added member whose uid is outside the band (409, both doors).
- **L2. The band is the only "system account" test, so the node's own admin login is mutable. [R]
  (operator ruling)** The stunt node's `debian:x:1000:1000:…:/bin/bash` passes disable (expiry
  locks its ssh login), delete (userdel also drops it from `sudo`) and SMB password. ANAS only ever
  creates nologin users. **Fix:** refuse mutations of accounts whose shell is not
  `nologin`/`false`, or rule explicitly that the band alone defines a share user.
- **L3. One locked encrypted dataset would block every automatic id pick. [R] (uncertain)**
  `zfs userspace` on a keyless dataset is very likely EACCES; any failed read refuses the create
  with 409 `id-check-unreadable` (`services/identity-ids.ts:271-283`); the explicit-id path still
  works. Not proven (no encrypted dataset on the stunt node). **Fix:** skip
  `keystatus=unavailable` datasets and name them in the confirm as unchecked.
- **L4. Add mount over a non-empty directory dead-ends in the panel, and the daemon's confirm
  contradicts §2. [V]** `POST /mounts` answers 409 + confirm code for a non-empty mountpoint
  (`routes/mounts.ts:555-566`, `mount.create`); the panel submits create/edit with plain
  `ANAS.runJob` and no `onConfirm` (`packages/pve-integration/src/67-mounts.js:2668-2682`), so the
  409 lands in `jobRejected` ("Add failed … will shadow the N item(s)") with no Proceed. EPICS §2
  Mounts says "Mountpoint must be an empty dir" — the daemon's confirm path is the deviation, the
  UI accidentally enforces the ruling. **Fix:** pick one — refuse non-empty (409, no code, matching
  §2) or route create/edit through `ANAS.confirmAndRun` like the Unmount/Disable/Remove doors
  (`:980-1047`) and amend §2.
- **L5. `packaging/install.sh` still takes a one-time `index.html.tpl.anas-orig` copy nothing reads.
  [V]** `install.sh:947-949`; never refreshed, never removed — a stale pve-manager file inside
  `/usr/share/pve-manager`, the 2026-10-14 H2 hazard class if restored by hand (cr.7's noted
  follow-up, still open). **Fix:** stop taking it; delete an existing one at install and uninstall.
- **L6. The mask misses the spellings Go tools print, and masking a word-like secret discloses it.
  [V]** `maskSecretValues` covers plain, `encodeURIComponent`, `+`-for-space and NFC/NFD
  (`services/secret-argv.ts:118-158`); Go's `url.QueryEscape` also encodes `!'()*` and `%q` escapes
  `"`/`\`. Probe (`t/c/mask-forms.test.ts`): `p%40ss%21w0rd%28x%29` and `"ab\"cd\\ef9"` stay
  unmasked; secret `copy` → `"Failed to [secret]: 403 Forbidden"`. **Fix:** add the QueryEscape and
  `%q`/JSON-escaped spellings; a minimum length on the secret schemas
  (`shared/schemas/backup.ts:301, 352`, `shared/schemas/identity.ts:177, 196`).
- **L7. An unsaved crypt probe masks only the plain value; rclone `-vv` prints the obscured one. [R]
  (uncertain)** `rclone-probe.ts:485-491`; the debug line (`fixtures/rclone/probe-crypt-good-debug-1.60.1.log:6,14`)
  reaches the reply only when it is rclone's last line. **Fix:** push the obscured env value into
  the mask too. Related: the saved-remote recovery uses the key-name rule only, so `crypt.password2`
  is not masked (`:402`).
- **L8. An unsaved CIFS mount test writes the probe credentials under `os.tmpdir()`. [R]**
  `services/mounts.ts:1155` — 0700 dir, removed in `finally`, but a daemon crash leaves plaintext in
  `/tmp`. **Fix:** `/run/anas`, as the rclone probe does.
- **L9. Some GETs act: a Sys.Audit-only user (or a cross-site top-level navigation, which carries the
  Lax cookie and needs no CSRF token) triggers them, and the job-queue backstop never sees them.
  [V]** `GET /iscsi/health` (`routes/iscsi.ts:76-77`) and `GET /status` (`routes/dashboard.ts:191`)
  run `readIscsiHealthWithQuarantine` (`services/iscsi-quarantine.ts:187+`), which unmaps a stub
  LUN, deletes its backstore and may unlink the file; `GET /replication/remotes`
  (`routes/replication-remotes.ts:80-84`) runs `ensureKeypair` (writes
  `/etc/pve/priv/anas/replication_key`). The acts are the daemon's own decisions (boot runs the
  quarantine too); the caller only picks the moment — but it contradicts "GET = read" (cr.27) and
  Principle 4. **Fix:** quarantine at boot + a POST repair verb, reads report only; create the
  keypair at install or on the first remote POST.
- **L10. `direct:true` (the runner-only flag) is accepted from any Sys.Modify client and skips the
  in-flight refusal. [V]** `routes/backup.ts:1334, 1351-1361`, `routes/cloud.ts:1097, 1114`;
  bypasses §2 "Run Now goes through the task's own unit", and two direct runs hold the task key
  SHARED. Runners identify as `root@pam` (`runner-poll.ts:59-67`), so timer runs and the real
  root@pam are indistinguishable in the audit, while the udev script says `system:udev-cache-event`.
  **Fix:** runners send `system:task-runner` (no `@`, the gateway can never produce it); the run
  routes refuse `direct` from anyone else.
- **L11. `GET /fs/browse` lets Sys.Audit list any directory as root, files included with `?files=1`.
  [V]** `routes/fs.ts:17-125` — names only, but `/root`, `/etc/pve/priv`, `/etc/anas/creds`
  included. **Fix:** restrict to share/mount/pool roots, or require Sys.Modify (only mutation dialogs
  use the picker).
- **L12. A percent-encoded node segment makes the gateway forward the decoded path. [R]**
  `packages/gateway/src/server.ts:120-124`: `GET /api/nodes/n%31/v1/pools%2Ftank` reached the daemon
  as `/v1/pools/tank`; same privilege, no security effect. **Fix:** build the marker from the raw
  segment or answer 400.
- **L13. Retiring a disk still zaps its whole GPT without destroy's per-partition ownership check
  (2026-10-14 M7 residue). [V]** Replace phase 4 zeroes only labelled slices then
  `sgdisk --zap-all` on the whole old disk (`services/ahr-expand-exec.ts:1522-1534`), with
  `oldWasHealthy` from the job-start pool (`:1428`); spare removal zeroes every partition and zaps
  (`services/ahr-spare.ts:326-329`); destroy keeps the GPT unless every partition is the pool's
  (`ahr-destroy.ts:186-188`). Since nf.1 a partition the operator cut in the largest disk's free
  tail can be a ZFS leaf — a later Replace or spare removal erases its table. **Fix:** reuse
  destroy's `classifyPartition` + `zappable` in both; compute `oldWasHealthy` from the re-read pool.
- **L14. One disk's `disk:` lock key has two spellings. [V]** `newDeviceLockId` keeps the by-id prefix
  the caller typed (`routes/pools.ts:481-483`, used at `:2492`); every other disk verb locks the
  inventory id (`diskClaim`, `safety/guard.ts:644`, `PREFIX_PRIORITY`). A `wwn-…-part4` attach and an
  AHR spare/cache verb on the same `ata-…` disk do not serialise. **Fix:** lock `disk:${disk.id}` of
  the inventory disk the gate resolved from `pkname`.
- **L15. Three AHR readers still turn "could not read" into "nothing there". [V]** `ahrPools()` in
  `routes/scrub.ts:79-86` catches into `[]` (`GET /scrub` silently drops AHR pools; `PUT
  /scrub/ahr/:pool` answers 404 for a live pool — against cr.35's "unreadable is never empty");
  `readNamedMdArrays` skips an array whose `--detail --export` fails (`services/ahr-identity.ts:178-181`),
  the md source of `ahrNameOccupancy` (`:579`). **Fix:** rethrow `AhrTopologyUnreadableError`
  (503) in scrub; `readNamedMdArrays` refuses on a non-zero `--detail`.
- **L16. The access editor passes unvalidated owner/group/entry names into `chown`/`setfacl` argv
  (2026-10-14 H5 residue; ruling (i)). [V]** `SetAccessRequest.owner/group` and
  `AccessEntry.name` are bare `z.string()` (`shared/schemas/access.ts:25, 134-135`); the non-walk
  chown argv is `[spec, mountpoint]` with no `--` (`services/access.ts:1061`); `buildAclSpec` joins
  names with `,` (`:263-273`). Probe (`t/g/chown-probe.test.ts`): `{"owner":"--reference=/etc/shadow"}`
  → `chown --reference=/etc/shadow /testpool/media`; entry name `media:r-x,o::rwx,u:nobody` with
  everyone `none` → `setfacl --set "…,o::---,u:media:r-x,o::rwx,u:nobody:r-x,…"`, and setfacl keeps
  the last `o::` (everyone rwx while the request and the job say none). Sys.Modify can set any of
  this anyway, so it grants nothing new; it is a truthfulness defect. **Fix:** `IdentityName` (or a
  numeric id) for owner/group/entry names, resolved via getent in the plan; `--` before chown's
  operands.
- **L17. iSCSI LUN verbs create, resize and destroy ZFS/AHR data holding only `iscsi-target:`/
  `iscsi-lun:` keys. [V]** WAVE3 §4.2 (`docs/WAVE3-DESIGN.md:394-396`) says `zpool:<guid>` is taken
  by every verb on anything in the pool and `ahr:` by every AHR verb; LUN add (sparse image + fstab
  ordering) locks `iscsiTargetClaim(iqn)` only (`routes/iscsi-mutate.ts:741, 765-776`); LUN delete
  with `destroyBacking` runs `zfs destroy -- <zvol>`/`unlink` (`services/iscsi-mutate.ts:1484-1497`)
  and resize `volsize` (`:1366`) the same way. A pool export/destroy and a LUN add on that pool share
  no key; the destroy's LUN-held gate can pass before the add maps the file. Harm mostly a busy
  failure (uncertain). **Fix:** LUN add/resize/delete take the backing's dataset or `ahr:` key —
  shared, exclusive for `destroyBacking`.
- **L18. The AHR destroy job refuses on a job queued AFTER it. [V]** `inFlightGate` excludes only itself
  (`services/ahr-guard.ts:204-208`) without `findActive`'s `before:` option (cr.38; the repair gate
  uses it, `routes/ahr-mutate.ts:439`). A confirmed destroy waiting for a slot fails "has a ahr.scrub
  job in flight" when a timer submits a scrub. Safe, wrong. **Fix:** `findActive(…, { before: self })`.
- **L19. The boot cache-recovery rung skips the expansion-intent gate the udev and operator doors apply.
  [V] (uncertain harm)** Boot spec gates only on `cache.state === 'failed'`
  (`services/ahr-boot-scan.ts:447-456`) and runs before the intent branch (`:339-352`); udev
  (`routes/ahr-cache.ts:418`) and detach (`:311-312`) refuse under any intent because
  `vgreduce --removemissing` must not run while a VG's shape is in flight; a half-done expansion's
  unassembled band reads `[unknown]` like a dead cache. `requirePoolVg` is the only backstop.
  **Fix:** add `guard.intentGate(...)` to the boot spec (skip and log).
- **L20. Permissions applies on AHR or plain paths are not serialised against each other. [V]**
  `accessClaims` gives a ZFS target an exclusive dataset key but an AHR target only `ahr:<uuid>`
  shared and a plain path nothing (`services/access.ts:1243-1246`); two recursive applies on one AHR
  directory run concurrently. **Fix:** an exclusive `access:<normalised dir>` key on every home.
- **L21. Doors still on the legacy `confirmGate` sign a hand-picked subset. [V]** AHR expand
  `{pool, addDisks, replace}` (`routes/ahr-expand.ts:313-321`) and replace `{pool, old, new}`
  (`:529-541`) bind no VG UUID, so within the TTL a destroyed and re-created same-name pool takes the
  code. **Fix:** `guardConfirm` with the VG UUID as the bound id.
- **L22. Remaining doors outside the guard (2026-10-14 M2 residue). [V]** `/replication/tasks/:name/run`
  still answers `{started:true}` with no job reference (`routes/replication-tasks.ts:466`); the remote
  test routes write `known_hosts` inline (`routes/replication-remotes.ts:274, 281`), swallow the
  registry write error (`:337-357`) and submit an empty audit job (`:368`); `?pin=true`/`?retrust=true`
  pin whatever key the host presents at that moment, not the fingerprint the operator was shown in
  the previous `hostkey-unknown` answer; periodic-scrub toggles (`routes/scrub.ts:163, 213`) take no
  lock, no PVE gate and no job re-read; cloud remote update re-checks nothing in the job
  (`routes/cloud.ts:481-485`) while delete does (`:539-560`). Smaller: a by-guid import takes no
  `zname:` key (`routes/pools.ts:1447`); `poolNameFreeGate` passes when `zpool list` fails
  (`:1398-1403`); the replication job never re-runs the target guard and a local target holds no
  `zfs:` claim (`routes/replication.ts:317-347`). **Fix:** return the job ref; pin/retrust as a job
  bound to the shown fingerprint; the toggles get `poolVerbSpec(…, mode: 'shared')`.
- **L23. The ZFS system-pool fact misses a bind mount of a pool's ROOT dataset. [V]**
  `services/system-mounts.ts:114-117` takes `split('/')[0]`, so findmnt's `tank[/home]` gives pool
  `tank[`; the AHR side strips the suffix. Probe: `{target:'/home',source:'tank[/home]',fstype:'zfs'}`
  → pool `tank` not a system pool. **Fix:** `stripSubvolSuffix` before taking the dataset head.
- **L24. cr.23 loosens when only the mount table is unreadable. [V]** `services/pve-footprint.ts:512-528`
  refuses on unreadable mount facts only together with unreadable boot facts; on an ext4-root node a
  failed findmnt answers "not a system pool" for a pool mounted at `/var`, against cr.23's "a
  missing fact may only tighten". The AHR gate fails closed (`services/ahr-guard.ts:156-159`).
  **Fix:** unreadable mount facts alone refuse.
- **L25. cr.24's pool references fail open on the pool's own path list and miss legacy-mounted datasets.
  [V]** `routes/pools.ts:351-354` (empty Map on `zfs list` failure — every path-based reference
  silently "none") and `:740-748` (only mountpoints starting with `/`, so a `mountpoint=legacy`
  dataset mounted from fstab is never attributed). **Fix:** an unreadable list is an
  `unreadableSources` entry; add findmnt targets whose zfs source head is the pool.
- **L26. The mount-family findmnt readers disagree on stacked mounts, and one ignores the exit status.
  [V]** `effectiveMountNode` returns the FIRST (bottom) non-autofs row (`services/mounts.ts:414-416`)
  while the inventory (`:96-112`) and `mountIndex` (`services/nested-filesystems.ts:252-264`) take
  the LAST (top) — two NFS rows at `/mnt/m`: the list shows the top source, `remountEntry`'s
  effective-options check (`routes/mounts.ts:1102-1106`) reads the bottom; `readFindmnt`
  (`services/mounts.ts:398-406`) ignores `exitCode`, so a failed read is "nothing mounted" for the
  mount guards (`routes/mounts.ts:168`); the pool mountpoint collision gate's `--json --real`
  (`routes/pools.ts:46, 983-986`) is blind to tmpfs/autofs at the target (documented fail-open).
  **Fix:** one "effective node" rule (last real row) in `parsers/findmnt.ts` for all readers; fail
  closed on a non-zero findmnt in guard reads.
- **L27. 2026-10-14 §4 residues, unchanged. [V]** `aclSupported` caches a failed probe for the process
  lifetime (`services/access.ts:458-461`) — with `supported=false` the plan skips the ACL read and
  plans from mode bits, the mask hazard the unreadable-ACL refusal guards (`:888-903`); recycle
  purge still lists before `lstat` and unlinks full paths (`recycle-purge.ts:185-199`).
  **Fix:** cache only `true`; dirfd-relative purge.

## 5. Workflow, process and documentation

**W1. The 0.4.4 release note claims four things the code does not do yet.** "Secrets stay out of
replies" (M1: cloud preview and run), "Every operation … checks again when its turn comes"
(H3: file restore and new-LUN restore), "A data mover … holds its source for the run" (M2:
not when the task or schedule was edited while the run waited), "changing anything … needs
`Sys.Modify`" read as a bound (H4). Each story was reviewed in isolation and is true for the
doors it touched; the note generalises. **Fix:** fix before the tag, or narrow the sentences.

**W2. EPICS §3 and the tracking documents are behind the proofs. [R]**
- "Owed" tags that the wave documents record as PROVEN: cr.11 (`LIVE-PROOF-0.4.4-wave1.md` R6),
  cr.14 (wave1 R4), cr.15 and cr.22 (wave1b R2/R3), cr.19 (wave1b R1), cr.23 (wave1b R4). Not
  resolved here: cr.25a/25b/45 and cr.34/35's N4/N5 (the label N4/N5 means different things in
  wave2b and wave3/3b, so the label alone does not show the proof). Re-tag from the wave tables
  before the tag.
- The read-job privilege ruling is stated as made in the code (`jobs/read-jobs.ts:5`,
  `jobs/authority.ts:16`: "operator ruling 2026-10-15") and as "Proposed … NOT yet ruled" in
  EPICS cr.28 (`docs/EPICS.md:235`); the branch is unreachable anyway (every POST needs Sys.Modify
  at the gateway, `packages/gateway/src/auth/policy.ts`), so an Audit-only user cannot run the
  cloud preview, the remote test or the catalog listing. Rule it; then a per-route gateway exception
  or delete the dead branch.
- `docs/IDENTITY-AUDIT-2026-10-06.md:8-13` "Progress (2026-10-14)" still marks #21–#47 open; #23
  and #46 (cr.20) and #45 (cr.27) are closed, #25 partly (M6), #24 open (M5).
- `docs/EPICS.md` grew from 85 KB to 145 KB (334 lines, 11 over 2,000 characters; the 0.4.4 §3
  block alone ~56 KB); 15 `LIVE-PROOF-*` files still sit in `docs/`; commit subjects over the 158
  commits average 114 characters (22 over 200, longest 473). Ruling (h)'s retrospective move is the
  fix for the first; the 2026-10-14 W4 fixes for the rest stand.

**W3. CI and release residues (2026-10-14 W3). [R]** Fixed: shell and perl suites in `test:unit`,
`release.yml` gated on build/unit/second-TZ/lint, `permissions:` blocks. Open: actions pinned to
`@v4` tags, not SHAs; `release.yml` grants `contents: write` workflow-wide while `npm ci` runs
lifecycle scripts with the persisted checkout token; `tests/integration/**` is never type-checked
and `eslint.config.js:13` still ignores `tests/integration/fixtures/**`; the tarball still ships
compiled `__tests__` and the `selfheal-*` bins (`make-release.sh:141` copies all of `dist`).
`AnasProxy-node.t` (the 57 node checks cr.27 cites) lives in `docs/probes/wave2-node/` and needs a
node — fine, but say so beside the suite.

**W4. Comments that no longer describe the code. [V]** `routes/datasets.ts:1580-1583` still
describes the removed "SetPermissions action" branch; `services/ahr-cache.ts:503-511`
(`dropMissingCachePv`) claims a band-count guard that only sees assembled arrays — LVM's own
refusal of `--removemissing` without `--force` is the real protection. The 2026-10-14 M5 bullet
"plain `runJob` without `onConfirm`" is still open for snapshot destroy (a client-side confirm over
a daemon door with no gate, `packages/pve-integration/src/60-datasets.js:3178-3203`) beside the
mount-create dead end (L4).

**W5. Two findings are invisible to the suites because the fake is fed the oracle, not the route.**
The cloud-preview unit test passes `secrets` straight into `runPreview`
(`services/__tests__/cloud-preview.test.ts:349`), so the route's empty-list bug (M1) cannot
fail it; `uninstall-schedules.test.sh` has no `anas-cloud` case, so M9 cannot fail it. Both are
route/packaging-level gaps a unit test over the helper never reaches — the same shape as ruling (l)
but one layer up. **Fix:** the cloud-preview test builds `deps` the way `routes/cloud.ts` does; the
uninstall test adds a cloud task. Standing: a story that adds a NEW reply-shaping or unit-family
path is proven at the boundary that ships it, not only at the helper.

## 6. Verified sound (incl. the regression re-check of 2026-10-14 §6 and its C/H fixes)

**2026-10-14 §6, item by item — every one STILL HOLDS after 158 commits. [V]**
- Gateway identity headers are built by the gateway, never copied: a fresh header set from the
  verified assertion (`packages/gateway/src/proxy.ts:161-184`); the cross-node forward copies only
  cookie, `CSRFPreventionToken`, content-type and `x-anas-confirm` (`:372-388`), and AnasProxy drops a
  client's `X-Anas-Auth` (`packages/pve-integration/perl/AnasProxy.pm:184-206`).
- Dev auth refuses to arm on a real node without the second override
  (`packages/gateway/src/auth/index.ts:22-33`); `anas.service` pins `ANAS_AUTH_PROVIDER=pve`.
- Cross-node forward: cluster-CA TLS, fail closed, never cached on failure (`proxy.ts:290-305,
  344-357`); peers from `.members` (`:321-331, 361-370`); node name checked (`server.ts:108`); loop
  guard (`:142-149`). New: the socket hop times out at 20 s (`proxy.ts:217-245`), the forward at 5 s
  connect + 25 s response (`:436-452`).
- Daemon socket 0600 after listen (`index.ts:63-70`), `/run/anas` 0755; node read: `anasd.sock
  srw------- root`, `/run/anas/proxy.key -rw-r----- root www-data`.
- No shell anywhere: `spawn` with argv arrays, no `shell:` (`executor/prod.ts:416, 545-546, 686`);
  the gateway's only child is `execFile` (`auth/providers/pve.ts:2`); no `execSync`/`sh -c`/`bash -c`
  in any package; every remote ssh command is constants plus validated names after `--`
  (`services/replication-transport.ts:231-261`).
- Secrets on stdin/env: `smbpasswd -a -s` (`routes/share-identity.ts:319-322`), `rclone obscure -`
  (`services/rclone-config.ts:531-533`), `revealObscured` in-process AES-CTR with no exec and no
  `rclone reveal` anywhere (`:615-640`), probe secrets as `RCLONE_CONFIG_*` env
  (`services/rclone-probe.ts:134`), `PBS_PASSWORD` env (`executor/prod.ts:419`), CHAP through
  configfs (`services/iscsi-mutate.ts:14-17`). The leaks in M1/M7/L6 are output masking and fstab
  read-back, not argv.
- Confirm codes single-use with expiry (`safety/confirm.ts` `verifyCode`); not bound to the minting
  user — acceptable, only a Sys.Modify holder ever sees one. Jobs keyed by uuid (`jobs/queue.ts:292`);
  cancel race-free (`:482-526`).
- ident.1–4: stamped retention; guid-bound pool/dataset confirms (`safety/confirm.ts` `bound`,
  `safety/stable-id.ts`); by-guid cleanup wipe (`routes/pools.ts:2802-2814`); reserved dataset
  segments (`shared/schemas/common.ts:72-95`); per-task hold tags; LUN rdev check
  (`services/iscsi-served.ts`); UUID-gated AHR destroy and boot ladder (`services/ahr-destroy.ts:216-223,
  528-536`); `(S)` spare removal; hashed cred names (`services/mounts.ts:769`); recycle symlink refusal
  (`recycle-purge.ts:143, 166-172`); PBS group uniqueness (`routes/backup.ts:811`).
- AnasProxy is not an open proxy: fixed loopback URL (`AnasProxy.pm:123-139`), forced Host
  (`:179-184`), `recurse => 0` (`:531`). Version bump: `packaging/bump-version.mjs:32-58`, every
  location reads 0.4.4.

**2026-10-14 Critical and High fixes — status at the line.**
- **C1 (ssh option injection): fixed.** `--` before the destination in both branches
  (`services/replication-transport.ts:105-129`) and in `ssh-keyscan` (`services/replication-remotes.ts:268`);
  `RemoteUser`/`RemoteHost` (`shared/schemas/replication.ts:236-264`); the test route parses
  `TestRemoteRequest` (`routes/replication-remotes.ts:382`). Probe (`t/g/c1.mjs`): user
  `-oProxyCommand=touch /x` and host `-oProxyCommand=id` refused; `fe80::1` accepted.
- **C2 (fstab injection): fixed.** `extraOptions` is a token list (`shared/schemas/mounts.ts:473`,
  `shared/formats/fstab.ts:96`); spec and mountpoint octal-escaped on write (`parsers/fstab.ts:500`),
  unescaped on read (`:568-569`), symmetric (`shared/formats/fstab.ts:61-76`). Read-side residue: M7.
- **C3 (system accounts): fixed for the target account** at both doors
  (`routes/share-identity.ts:652, 683, 1394, 1416`, re-run by `guarded`). Residues: L1 (member uid),
  L2 (admin login in the band).
- **H1 (CSRF) and the Amplifier: fixed.** AnasProxy calls PVE's `auth_handler`
  (`AnasProxy.pm:403-405`), which verifies the CSRF token for every non-GET (HEAD too); the UI sends
  it (`packages/pve-integration/src/10-api.js:68-74`); the daemon is JSON-only (415, cr.26) and the
  gateway forwards a body-less non-JSON content type so that holds through `/anas`
  (`proxy.ts:138-145`). `$rpcenv->check(user, '/', [priv])` (`AnasProxy.pm:319-322`); the MAC binds
  version, user, privileges, timestamp, method and path+query with a 30 s window and
  `timingSafeEqual` (`AnasProxy.pm:340-347`; `packages/gateway/src/auth/assertion.ts:34-38, 102-139`);
  GET/HEAD → Sys.Audit, else Sys.Modify (`auth/policy.ts`); the daemon backstop refuses a submit
  without the privilege and fails closed on a missing header (`jobs/authority.ts:60-73, 115-127`).
  Probe (`t/b/probe.ts`, real `createServer` + `PveAuthProvider`): a GET-signed header on POST → 401,
  signed for another path → 401, Audit POST/OPTIONS → 403, Audit HEAD → 200, a client-supplied
  `x-anas-privileges` → 403 and the daemon received only the signed list. The body is not bound (by
  design: the header travels loopback only). Node reads: `:85/anas/installed` → "served through
  pveproxy on :8006 only"; spiceproxy answers CONNECT only; the gateway on 127.0.0.1:3000 answers a
  direct call 401; the installed `AnasProxy.pm` has the repo's sha256. Residues: L9 (GETs that act),
  L10 (`direct:true`), L11 (`/fs/browse`), H4 (what Sys.Modify buys).
- **H2 (uninstall module rollback): fixed** — always marker excision under `perl -c`
  (`packages/pve-integration/uninstall.sh:14-20, 149-175`), a stale `.anas-orig` swept (`:196`);
  `proxy-install.test.sh` 115/115. Residue: L5.
- **H3 (smb.conf/exports/rclone injection): fixed** — `shared/formats/{smb-conf,exports,rclone-conf}.ts`
  at every write door (`shared/schemas/shares.ts:216-223, 251-253, 275, 292, 312`;
  `shared/schemas/cloud.ts:143-152`), newline backstop in the rclone writer
  (`parsers/rclone-conf.ts:239-240`). Probe (`t/g/h3.mjs`): `validUsers:["bob\\"]`, a trailing-`\`
  comment and path, a newline in `workgroup`, NFS path `/tank/a"b`, spec
  `* 10.0.0.0/8(rw,no_root_squash)` and option `rw,no_root_squash` all refused.
- **H4 (ZFS argument injection / force): fixed** — `name:"-aDf"` and `guid:"-aDf"` refused; `force`
  confirm-gated (`routes/pools.ts:2054, 2134-2162`); `DiskId` on every disk field
  (`shared/schemas/zfs.ts:355, 396, 398, 520`); unknown disk refused, unreadable inventory fails closed
  (`pools.ts:2040, 2248`). `AttachDiskRequest.existingDiskId`/`targetVdev` are still bare strings
  (`zfs.ts:614-616`) but are resolved against the parsed pool status before any argv
  (`pools.ts:1137-1156, 1228`).
- **H5 (legacy permissions route): removed.** Its input class survives in the access editor (L16);
  stale comment W4.
- **H6 (AHR LVM teardown): fixed** — `requireOwnedVgPvs` before the first act
  (`services/ahr-destroy.ts:306`), foreign/under-reported/all-`[unknown]` refused
  (`services/ahr-identity.ts:432-458`), `pvremove` on proven PVs only (`ahr-destroy.ts:419-428`),
  `lvs`/`pvs`/`vgs` fail closed (`:327-330, 401-414`), `ahrNameOccupancy` covers VG names and fails
  closed per source (`ahr-identity.ts:569-611`), `isOwnedArray`'s fallback narrowed (`:143-157`).
  Residue: L15 (the per-array `--detail` skip).
- **H7 (restore symlink): fixed** — random probe name (`services/backup-restore-files.ts:587`), marker
  as a random `O_CREAT|O_EXCL|O_NOFOLLOW` temp + rename (`:711-725`), cleanup `rm -f` on the exact
  path (`:968-978`).
- **H8 (request-time-only checks), bullet by bullet.** (1) ZFS create/add/attach composability in
  the job: fixed (`routes/pools.ts:1415-1419, 2271-2276, 2468-2472`; the attach family's topology
  gate resolved by ruling cr.47a, PVE gate only, `:1385`). (2) Pool destroy/export and rollback
  LUN-held and system-pool in the job: fixed (`poolGuardSpec` `pools.ts:1327`, `rollbackLunGate`
  `routes/datasets.ts:1003`, recursive-destroy children bound by createtxg `:826-838`, upgrade and
  mountpoint bound to the guid `pools.ts:1771, 1915`). (3) AHR expand/replace composability in the
  job: fixed (`services/ahr-expand-resume.ts:294-301`); cache attach replaced its missing confirm with
  a both-door `blkid -p` signature gate (`routes/ahr-cache.ts:280-302, 327-344`), deliberately
  unconfirmed (`:37-45`). (4) AHR destroy in-flight/intent/system/LUN gates in the job: fixed
  (`routes/ahr-mutate.ts:966-975`, mountpoint/remount `:731, 851`), but see L18. (5) iSCSI sessions
  compared in the job (`services/iscsi-served.ts:302`), target update/state/delete revision-bound
  (`routes/iscsi-mutate.ts:577, 638`), add-LUN index from the fresh target (`:735-741`): fixed. (6)
  Schedule fire re-read in the job: fixed (`routes/schedules.ts:311-330`), but its claims come from
  the route read (M2). (7) Per-object locks: fixed (cr.33, `jobs/locks.ts`; grants all-or-nothing, so
  no deadlock); holes H3 (restores) and L17 (LUN backing verbs).
- **M1 (executor timeouts): fixed** — the executor owns a deadline (process-group TERM → 5 s → KILL,
  `executor/deadline.ts`, `prod.ts:175-299, 412-460`); lanes request 10 s / job 300 s / background
  300 s; per-command budgets (`executor/command-budgets.ts:52-85`); seven `timeoutMs: null` long-lane
  sites, each with a required reason and listed by a test (`__tests__/long-lane-sites.test.ts`).
- **M3 (confirms bind blast-radius flags): fixed on every guard door** — pool destroy `cleanup`
  (`pools.ts:2724`), dataset destroy `recursive` (`datasets.ts:1938`), rollback `force` (`:2225`),
  import/create `force` (`pools.ts:2052, 2134`), LUN delete `destroyBacking`
  (`routes/iscsi-mutate.ts:1107`), mount remove `removeMountpointDir` (`routes/mounts.ts:922`), AHR
  create `disks` (`routes/ahr-mutate.ts:658`). Not on the legacy-confirm doors: H3, L21.

**New 0.4.4 machinery, checked and sound where it is applied.**
- The guard (`safety/guard.ts`): one `GuardSpec` drives route and job for every ZFS pool verb
  (scrub, trim, upgrade, set, mountpoint, create, import, add/remove vdev, attach/replace/raidz-expand,
  export, destroy), every dataset/snapshot verb, every AHR verb (create through cache event; expand
  and replace via `expansionGuard`), iSCSI target and LUN update/delete, mounts, SMB/NFS shares and
  access, task and schedule CRUD. Lock keys are spelled once: every mount key through
  `normalizeMountpointPath` (`pools.ts:1423, 1928`; `ahr-mutate.ts:611, 737`; `mounts.ts:384, 433`),
  SMB keys case-folded, disk keys whole-disk by-ids (except L14). [R]
- Identity: only `USERGROUPS_ENAB` is read from login.defs, per guard run, unreadable → "removes"
  (`routes/share-identity.ts:86-123, 499-510`); the band 1000..60000 (`shared/schemas/identity.ts:80-81`)
  matches the node's `UID_MIN/UID_MAX/GID_MIN/GID_MAX` and is used identically by `isShareRelevant`,
  `isMutableShareId` (`parsers/getent.ts:41-55`) and the pick (`services/identity-ids.ts:448-452`);
  every create passes explicit `-u`/`-g` (`routes/share-identity.ts:1489, 1700`); the pick fails
  closed and `promisedIds` + the job re-check close the pick/create race (`:908-937, 1121-1140`);
  userdel's private-group removal is mirrored (`:150-158`) with the group-delete gates re-run on the
  going group (`:745-768`); group delete refuses a primary group (`:715-738`). Identity suites
  147/147. [R]
- Secrets, outside the M1/M7 doors: the PBS family masks every output that leaves
  (`services/backup-runner.ts:336-339, 466-473, 1048`, `backup-prune.ts`, `backup-reads.ts`,
  `backup-restore.ts`, `backup-restore-files.ts`, `backup-catalog.ts`); cloud remote GETs return
  `secretsSet` only (`services/rclone-config.ts:398-416`); the unsaved probe's config copy lives in a
  0700 dir under `/run/anas` (`services/rclone-probe.ts:141, 279-296`); validation errors carry no
  values (`validation.ts:12-18`); the wire `Job` carries no submitter params (`jobs/queue.ts:373`). [R]
- AHR: every consumer of the typed topology error refuses rather than acts (guard reads throw →
  refusal; `selfheal-reconcile` records and stops; backup/cloud runs name the lock they do not hold,
  `services/backup-consistency.ts:187-196`, `services/source-claims.ts:124-131`; iSCSI refuses "not on
  storage ANAS manages"), outside L15. Cache detach (cr.50) reads fail closed
  (`services/ahr-cache.ts:131-153, 216-221`), asks `requirePoolVg` first (`:666-669`), skips a slice
  that is another VG's PV (`:641-649`), `vgreduce`s only PVs on its own labelled slices (`:702-708`),
  never reads "gone" from an unreadable tree (`:549-553, 572-592`), and the retry is bounded. [R]
- Walks and mounts, outside H1/H2: a recursive plan refuses an unreadable ACL before any
  `setfacl -b` (`services/access.ts:888-903`); the walk scope is bound by the plan's revision
  (`:905-926`); dead remote mounts below the target refuse (`:700-708`); `-xdev` plus a prune of every
  mount not named, `.zfs` pruned (`services/access-walk.ts:103-135`); the `x-anas.*` tokens are refused
  in `extraOptions` (`shared/schemas/mounts.ts:473-485`); automount stop goes through
  `systemd-escape` (`services/mounts.ts:1187, 1214`); the fstab-exists gate and creds-after-fstab
  ordering hold at both doors (`routes/mounts.ts:427-429, 590, 611-614`). [R]
- UI and packaging: encode-by-default holds (`00-core.js:335-386`, `10-api.js:225-230, 338-346,
  578-584, 913-918`; no `alertHtml`/`toastHtml` caller outside core; no double encoding); every
  `ANAS.api` call reads the CSRF token at call time (`10-api.js:69-72`); a missing Sys.Audit renders
  the privilege panel (`20-notinstalled.js:53-66, 213-216`); the 2026-10-14 M5 bullets for `pollJob`
  (`10-api.js:268-399`), replication delete (`65-replication.js:2198`) and poll re-selection (cr.46,
  66 harness checks) are fixed; the installers run `set -euo pipefail` with an EXIT trap and
  `perl -c` gates and reload (not restart) pveproxy when only the module changed
  (`packages/pve-integration/install.sh:37, 46-75, 138-143, 224`); the proxy key is written via an
  exclusive temp, fchown/fchmod before any byte, rename (`packages/gateway/src/auth/proxy-key.ts:72-86`)
  and removed on stop (`gateway/src/index.ts:36`); `release.yml` gates on build, unit, second-TZ and
  lint (cr.8); the DESIGN route index lists all 152 registered routes. [R]

## 7. Suggested order of work

1. **C1** — `SnapshotSchedule.name` → `SingleLine` plus a newline refusal in the snapshot unit
   writer and a rendering test. One request to root; the cheapest fix in this document.
2. **H4** — an operator ruling, today: is `Sys.Modify` through ANAS root-equivalent? It decides
   whether H1's and H2's escalation readings need closing or only documenting, and the release note
   gains one paragraph either way.
3. **H1 + H2** — one `mountTargetRefusal(path)` at every mountpoint door (route and job; H1's
   accident reading stands whatever H4 rules), and the access walk moved to `-execdir` + no-follow.
4. **H3** — file restore and new-LUN restore onto `guardCheck`/`guardConfirm` with the whole request
   signed, pre-flights re-run in the job, destination claims, and the storage.cfg read failing closed.
5. **M1, M2** — the cloud preview/run mask, and the claim-bearing fields bound as revision; both make
   a release-note sentence true (W1).
6. **M3, M8** — the two AHR seams (partition labels across doors; the cache event reported delivered
   on refusal).
7. **M4–M6, L1–L3** — identity: strict passdb in gates and jobs, the same-case orphan, the ACL-grant
   skip (or narrow the §2 ruling), member uid, the admin-login question.
8. **M7, M9** — the shared credential-key list for fstab read-back; `anas-cloud` in the uninstall
   loop with its test (W5).
9. **W1–W5, then §4** as grooming allows; W1 decides whether the release note ships as written.

Every finding above is a door the 0.4.4 machinery (guard, mask, per-format layer, privilege check)
was not extended to — one unit-file field, two restore verbs, the mountpoint doors, two cloud-output
paths, one walk — rather than a defect in that machinery; nothing the 2026-10-14 review recorded as
fixed or sound has regressed.
