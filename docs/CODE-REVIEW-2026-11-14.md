# Whole-project code review — 2026-11-14

**2026-11-14:** every finding in this document was fixed in the release that followed it.

**Status:** read-only review at main `7ca16714a` (everything built for the release after 0.4.5, unreleased), operator-ordered before that release ("we run a full-codebase review on opus"). Nothing here is fixed by this document; it is the evidence for the `cr3` stories in `docs/EPICS.md`. Operator, on the findings as they arrived: "Agreed - must fix before release - we should catch the lower priority too since we have it open."

**How it was done.** Fourteen reviewers, one per area ("door"), each reading its files in full against `docs/PRINCIPLES.md`, EPICS §2 and `docs/DESIGN.md`, plus one cross-cutting pass for values shown as state that no read supplied (operator: "Hard-coded values that don't derive from actual state are worrisome."). Each reviewer proved a defect before filing it: a probe that runs the real function, route or panel file with constructed input, or the real tool (`rclone`, `proxmox-backup-client`, `testparm`, `setfacl`, `find`) on a scratch tree. The probes are kept outside the repository and each becomes the failing test of its fix.

**Reading a finding.** `AREA-<severity><n>`: **C** = root command execution, data loss or a wrong object destroyed by an ordinary request; **H** = a wrong destructive act, a leaked secret or a lie about data safety under a plausible condition; **M** = a wrong answer or stranded state the operator can recover from; **L** = everything else worth a line. `DEFECT repro` = reproduced by a probe; `DEFECT read` / `line path` = traced line by line, not run; `POSSIBLE` = suspected, with what would settle it; `NOTICED` = worth knowing. Paths are relative to `packages/daemon/src` unless they name another package or a panel file (`NN-name.js` is under `packages/pve-integration/src`). A line number is the reviewer's at `7ca16714a`: confirm before fixing.

**Coverage is stated per area** (files read in full, in part, not reached). A file not reached was not reviewed.

---

## Settled in a browser (PVE 9.2, ExtJS 7.0.0.168)


SETTLED: a ComboBox with the DEFAULT BoundList template renders displayField as RAW HTML: the default combo list renders HTML unescaped, so markup in a row label becomes live elements in the list.
  => replication M3 (remote zpool list lines into the pool combo) and backup-panel M5 (PBS group ids / archive file names into combos) are REAL HTML injection; both rise to H (a compromised replication target or PBS server gets script into the admin's PVE session). Fix both ends: validate the lines at the daemon (PoolName; PBS id/archive charset) AND `listConfig.tpl` with {label:htmlEncode} on every combo whose rows come from command or server output. Sweep ALL combos in the panels for this.
SETTLED: btn.setTooltip stores the raw string in data-qtip (no encoding by ExtJS).
NOT SETTLED by this run: the QuickTip body render. ExtJS QuickTip puts the attribute text into the tip as HTML by design (PVE's own code double-encodes); treat single-encoded data-qtip and raw setTooltip as to-fix: encode twice / enc() at each sink (39-ahr.js:1660, 30-pools.js:601, 60-datasets.js ~950, 69-scrubs.js:1085,1136,1146,1257,1263, 12-picker.js:1234, 14-permissions.js:523).

---

## Cloud sync

Coverage: cloud — daemon + shared read in full; 72-cloud.js ~30% (renderers, remote dialog, wizard submit).

- **CLOUD-C1** DEFECT repro  services/rclone-probe.ts (testRemote), routes/cloud.ts (the remote Test route), shared/schemas/api.ts (READ_JOB_ROUTES), gateway policy.ts — A caller holding only the read privilege could have a command run as root through the Test of an unsaved cloud remote, because that Test was admitted as a read and copied every submitted option to rclone; other backend options of the same Test could create directories anywhere on the node. Fixed: testing an unsaved remote requires Sys.Modify; only the saved-remote (by name) arm stays a read job. NOTE: with Sys.Modify = root-equivalent by ruling, option allow-listing is secondary; the privilege boundary is the defect.
- **CLOUD-H2** DEFECT repro  services/rclone-config.ts:100-129 — the secret-name rule missed three options that hold a credential (a private key, a service-account credential, a backend's authorization token), so a caller holding only the read privilege could read them in plain in the remotes list, job results and the edit prefill. Fix: add them to SECRET_NAMES + a capture test over the catalogue help text.
- **CLOUD-H3** DEFECT repro  services/cloud-preview.ts:222 vs cloud-runner.ts:903-904 — sync preview dry-runs the LIVE tree (crosses into child datasets) and says "would delete 0"; the run reads <parent>/.zfs/snapshot/<label> where children are empty dirs and DELETES the destination's copy of every nested filesystem. Empty-source guard (:859-869) also reads the live tree. Fix: preview and guard evaluate the tree the run reads (--one-file-system; judge emptiness on snapshot root).
- **CLOUD-M4** DEFECT repro  cloud-runner.ts:888, routes/cloud.ts:1079 — consistency derived from task.source as written, not realpath (backup fixed: cr.64b2-iii (O), backup-runner.ts:702): symlinked source snapshots the wrong dataset, rclone follows the link to LIVE data, result says "Consistency: snapshot".
- **CLOUD-M5** DEFECT repro (daemon) / read (panel)  shared/cloud-guide.ts:157-168 via routes/cloud.ts:478; 72-cloud.js:779-829, 1137-1149 — a remote with its own OAuth client cannot be edited: pair check ignores the stored secret (Save disabled; secret-only PUT refused "must be set together").
- **CLOUD-M6** POSSIBLE  cloud-preview.ts:202, cloud-runner.ts:856/859 — in-process fs.stat/readdir on source: dead hard-NFS stalls libuv threads; inline preview reachable on Sys.Audit.
- **CLOUD-M7** POSSIBLE  services/cloud-retarget.ts:25-45 — retarget confirm misses sftp/ftp `user` (relative paths resolve under the login's home).
- **CLOUD-L8** POSSIBLE  cloud-units.ts:225-228 (routes/cloud.ts:530, 622/654) — referencing-task lookup fails open (unreadable unit dir = no tasks) -> opens delete refusal and retarget confirm; listServiceUnitsChecked exists.
- **CLOUD-L9** POSSIBLE  routes/cloud.ts:645-672 — remote delete by name, no identity binding, no lock.
- **CLOUD-L10** NOTICED  routes/cloud.ts:1115 — PUT task parses with defaults: omitted enabled re-enables, notify/mode/excludes reset (panel sends full body).
- **CLOUD-L11** NOTICED  72-cloud.js:1506-1527 — edit-mode Test drops other stored secrets -> false auth failure.
- **CLOUD-L12** NOTICED  rclone-config.ts:353/422 — any failing config dump mentioning password/encrypted/decrypt reported as password-protected file; list returns empty.

Other doors: source-claims.ts:201 fs.realpath in-process; source-guard.ts unreadable fstab fails open; ANAS.sched.pillHtml/softPill/runErrorTip encoding unverified.
Could not verify: rclone 1.60.1 goconfig quoted values; C1 on rclone 1.60.1 itself; dead-NFS stall; panel half of M5.

## Backup (daemon)

Coverage: backup (daemon) — 15 files in full, 8 in large part; NOT reached: routes/backup.ts 2366-2703 (new-LUN route), schema 540-1000 and 1320-1600.

- **BACKUP-H1** DEFECT repro  routes/backup.ts (the repository groups listing) -> services/backup-reads.ts — A caller holding only the read privilege could make proxmox-backup-client send a repository's STORED PBS password or token to a host of the caller's choosing, because a parameter of the groups listing reached pbc's argv unchecked as a positional, where pbc could read it as an option. Covers pve:<id> repositories too. Related unchecked class: BackupBrowseRequest.snapshot/.archive (schema :1706,1708) bare z.string() (not exploitable today). Fix: validate group as <type>/<id>; `--` before positionals in every pbc argv builder (pbc `--` not probed).
- **BACKUP-H2** DEFECT repro  services/backup-runner.ts:99, 469-470 (routes/backup.ts:1518-1562, backup-task.ts:91-94) — every pbc "backup timestamp is older than last backup" is classed benign too-soon skip; a node clock BEHIND the newest snapshot (RTC/NTP step back) makes every scheduled run exit 0, row "success", lastSuccessAt advanced, mail "nothing new to back up" — no backup taken until the clock passes. Fix: too-soon only when the last local success is within seconds; else fail naming the clock.
- **BACKUP-M3** POSSIBLE  services/source-claims.ts:201-219 — in-process fs.promises.realpath unbounded on the run door (routes/backup.ts:1412, :1493; cloud too): dead hard-NFS blocks a libuv thread; enough of them exhaust the pool. source-guard.ts:196-211 uses `timeout realpath -e` for the same paths. (cloud M6 same class)
- **BACKUP-M4** DEFECT repro  routes/backup.ts:1262-1295 — PUT /backup/tasks/:name parses with defaults: omitted enabled -> true (re-enables a disabled task), notify -> always, mode -> default (metadata continuity lost), limitNofile -> 1024, retention dropped. (panel sends whole body; same as cloud L10 and the recorded replication PUT bug)
- **BACKUP-M5** DEFECT (line path)  services/backup-restore.ts:779-804 (:743) — failed image restore + failed re-enable: "THE TARGET IS STILL DISABLED" pushed to warnings then discarded; thrown error lacks it. Same shape backup-runner.ts:841-845 (transient not destroyed), backup-zvol.ts:231-257 (snapdev not restored; next run reads visible as prior and never restores).
- **BACKUP-M6** DEFECT repro  services/backup-runner.ts:127-130 — buildRepoString without brackets: IPv6 host -> "unable to parse repository url" on every run; Test reports stage auth. Reproduced against the real pbc.
- **BACKUP-M7** POSSIBLE  routes/backup.ts:2927 — file-restore gates never ask unmountedMountFor about the destination: restore into an unmounted dataset's empty mountpoint dir "completes", files hidden when it mounts.
- **BACKUP-L8** DEFECT (line path)  backup-restore-files.ts:1259-1273 + routes/backup.ts:2797-2803 — pathKind null = absent AND stat timed out: existing dir treated as created by this restore (confirm skipped; on failure may write .anas-restore-partial or rm -d).
- **BACKUP-L9** NOTICED  backup-snapshots.ts:258-291, task-units.ts:247-263 — transients swept only for the task's CURRENT targets (deleted task / moved path leave them).
- **BACKUP-L10** NOTICED task-units.ts:207-216 — units written with plain writeFile; failed daemon-reload after write = config already stored; removeTaskUnits ignores failed disable.
- **BACKUP-L11** NOTICED backup-repos.ts:173-180 — readRepoSecret maps any read error to null -> "No secret stored", credentialsSet false.

Other doors: gateway no per-route body/query validation (Principle 6?); pve-notify free-text into body lines.
Could not verify: pxar extractor vs planted symlink in an in-place target; dead-NFS; IPv6 in storage.cfg; journald LineMax vs big result line.

## Backup (panel)

Coverage: backup-panel — 68-backup.js read in full (8047 lines).

No C, no H.
- **BACKUP-PANEL-M1** DEFECT repro  68-backup.js:6045-6094, 6117-6122 — switching between two pxar archives of one snapshot keeps the previous archive's home and selections and submits them with the new archive (applyArchiveHome returns early when the new archive has no home; state cleared only on KIND change). A single-file in-place restore is not confirm-gated -> lands in the wrong directory silently. Same by reading: typed #restoreSnapshot (7247), repo/namespace/group change (7187-7235).
- **BACKUP-PANEL-M2** DEFECT repro  68-backup.js:3479-3497, 1462-1468, 1683-1694 — a task with one block-image archive whose path is not an iSCSI LUN can be created but never edited: edit derives "block", sends lun {targetIqn:"",index:0} -> schema 400.
- **BACKUP-PANEL-M3** DEFECT repro  68-backup.js:3397-3405 vs routes/backup.ts:1662 — retention Preview on an edit with the namespace field cleared previews the STORED namespace (omitted = stored), Save treats omitted = cleared: preview describes a different group than the prune will hit.
- **BACKUP-PANEL-M4** POSSIBLE  68-backup.js:3443-3455, 4038-4080, 4365-4426 vs routes/backup.ts:1277-1290 — Edit and Enable/Disable send the whole task from a stale grid snapshot; revision bound at the route, not at dialog open -> lost update between two admins/tabs (also 75-iscsi.js:2213-2224 "Edit task…").
- **BACKUP-PANEL-M5** POSSIBLE (H if BoundList renders raw)  68-backup.js:7913-7916, 5993-5996; combos 7218-7228, 7267-7276 — PBS-server-controlled group ids and archive file names into combo labels unencoded; daemon parsers (services/backup-reads.ts:265-374) pass any backup-id/filename; the daemon half was reproduced. SAME browser question as replication M3.
- **BACKUP-PANEL-L6** DEFECT repro  68-backup.js:1604-1617, 1650-1655, 434-449 — files task inherits a LUN's group id after a kind switch (lun-<serial>); daemon guards block tasks only (routes/backup.ts:793).
- **BACKUP-PANEL-L7** NOTICED  68-backup.js:4878-4890, 5134 + routes/backup.ts:485-499 — auth type switch on edit keeps the old secret under the new meaning.
- **BACKUP-PANEL-L8** NOTICED  68-backup.js:4661-4668, 4971-4977 — any error from repo Test shown as stage tcp "cannot reach the host".
- **BACKUP-PANEL-L9** NOTICED  68-backup.js:3896-3900, 2873 — default row {etc,/etc} seeded as a stored name: retyped path keeps archive name `etc`.
- **BACKUP-PANEL-L10** NOTICED 68-backup.js:1095-1098, 3450-3452 — failed repositories read = empty list -> "Register a PBS repository first".
- **BACKUP-PANEL-L11** NOTICED 68-backup.js:6426-6444 — "This LUN" ignores a source change (confirm does name both).
- **BACKUP-PANEL-L12** NOTICED 68-backup.js:6379-6384, 6748-6751 — failed LUN inventory read greys "This LUN" with no reason.

Other doors: routes/backup.ts:639-643 inline repo Test with a name and no secret uses that name's stored secret against the request's host (Sys.Modify-scoped). 12-picker.js renders the same PBS strings.
Could not verify: BoundList default encoding; whether tree navigation destroys the Backup view mid-restore (poll stops silently); lost update in practice.

## Shares, identity, access

Coverage: shares — core routes/services/parsers read in full; share-identity.ts ~45%; panels 70/80/14/12 skimmed.

- **SHARES-H1** DEFECT repro  parsers/smb-conf.ts:28, 71-77 — SECTION_HEADER_RE `^\[(.+)\]\s*$` misses a header with trailing text (`[private] ; staff only`); Samba ends the name at the first `]` (proven with testparm 4.25). Next stanza folds into the one above: delete removes several shares; edit changes another share's valid users; create re-points an existing section; recycle purge deletes in the wrong path's #recycle; identity refs + uid-pick scan wrong; `[global] # x` -> second [global] prepended. Fix: parse headers as Samba does, header line verbatim, testparm-checked fixture.
- **SHARES-H2** DEFECT repro  services/access.ts:1083-1087, 1118-1122, 1137-1141, 1156-1160 (+ stat :441) — the non-recursive permissions writer followed a symbolic link at the target's final component: a user with write access through an enclosing share could replace the target with a link, and the administrator's next Apply then ran root ACL, mode and ownership changes on whatever the link pointed to; the PVE gates judged the path lexically. Recursive form was hardened (10-16 H2), mountpoint-only form not. Fix: lstat + refuse symlinked final component or realpath + re-gate; setfacl -P, chown -h.
- **SHARES-M3** DEFECT repro  services/access.ts:972-975, parsers/getfacl.ts:134-141, access.ts:263-274 — any Apply restates every named ACL entry through the 3-level abstraction and forces m::rwx: mask-clamped entry gains write, --x loses traverse, -w- -> rwx, r-- -> r-x; adds default ACL + setgid; GET shows granted not effective. DESIGN "Layered access" says the daemon preserves them.
- **SHARES-M4** DEFECT repro  routes/shares-smb.ts:413-426, shares-nfs.ts:256-264 via pve-footprint.sharePathClaim (:503-528) — failed `zfs list` => "no claim" => share/export created on a PVE-owned dataset (create door only). Fix: cannot-see verdict refuses. (Touches shares.r1 code from this release.)
- **SHARES-M5** DEFECT repro  parsers/exports.ts:135-186 — reader ignores backslash continuation, mid-line # comments, \ooo escapes: wrong clients shown; remove/replace orphan continuation lines.
- **SHARES-L6** DEFECT repro  routes/shares-smb.ts:592/707 — trailing space in path passes schema; Samba trims; gate judged untrimmed string (API caller only; panel trims). % substitutions in path read as missing.
- **SHARES-L7** POSSIBLE  shares-smb.ts:604-627, shares-nfs.ts:256-281 — ownership gate at route only, not re-run in job (ruling j).
- **SHARES-L8** POSSIBLE  shares-smb.ts:286-316, 475-496 — failed smbstatus = "no connections" skips the interface-binding confirm.
- **SHARES-L9** POSSIBLE  recycle-purge.ts:330,252 + packaging/systemd/anas-recycle.service — sequential lstat, no TimeoutStartSec: a dead hard mount hangs the purge forever.
- **SHARES-L10** NOTICED  shared/schemas/identity.ts — passwords accept control chars; newline truncates via smbpasswd -s stdin.

Other doors: disk-identity-cache.ts:393 smartctl no `--` (low).
Could not verify: exportfs -ra on an orphaned continuation line; Samba % macros in path; smbstatus service case.

## Datasets, snapshots, schedules

Coverage: datasets-schedules — daemon files read in full; panels 60/69-* only the request/submit parts.

- **DATASETS-SCHEDULES-H1** DEFECT repro  routes/datasets.ts:907-920, 960-961, 2209-2210 — forced rollback computes the swept snapshots from a list sorted by `creation` TIME (parsers/zfs-list.ts:266-270 parseSnapshotList), but `zfs rollback -r` destroys by createtxg. A received snapshot (keeps sender's creation time) or a stepped clock makes the orders disagree: snapshots destroyed that the confirm never named and whose holds were never read; a held one => partial rollback ("dataset is busy" after destroying others). Fix: sweep set = txg > target txg (readRollbackIds already reads createtxg) for scope, hold gate and warning. Not run on real ZFS.
- **DATASETS-SCHEDULES-H2** DEFECT repro  services/snapshot-schedules.ts:511-532 + routes/schedules.ts:487-520 — schedule owns snapshots by stamp `anas:schedule=<id>`, id = operator-typed slug, stamp survives schedule delete ("snapshots it already took are kept", 69-snapshots.js:1765). A NEW schedule with the same id adopts them: prunes to its policy, destroys ALL on an excluded child. SCHEDULES-DESIGN.md:22 sentence is wrong. Fix: per-incarnation uid in unit JSON + stamp, or refuse/confirm-gate an id whose stamps already exist under the target.
- **DATASETS-SCHEDULES-L3** NOTICED  snapshot-schedules.ts:340-342, 523-529 — prune destroys stamped snapshots on an excluded child even if PVE-owned (ownership gate skips excluded subtrees).
- **DATASETS-SCHEDULES-L4** DEFECT repro  services/nested-filesystems.ts:159-165 — prune paths passed to `find -path` are globs; a mount path containing glob metacharacters is not pruned -> hang guard void, scan times out.
- **DATASETS-SCHEDULES-L5** POSSIBLE  69-scrubs.js:1085,1136,1146,1257,1263 (also 12-picker.js:1234, 14-permissions.js:523) — single-encoded value in data-qtip; QuickTip renders decoded attribute as HTML. Needs browser probe.
- **DATASETS-SCHEDULES-L6** POSSIBLE  services/scrub-schedules.ts:316-322 — unreadable/unparseable anas-scrub unit reads as null -> pools [] -> enabling one pool rewrites the unit dropping the others.
- **DATASETS-SCHEDULES-L7** NOTICED   scrub-schedules.ts:91-99 — failed `zfs get org.debian:periodic-scrub` reported as enabled. (invented-state class)
- **DATASETS-SCHEDULES-L8** NOTICED   snapshot-schedule-units.ts:306,328 — schedule name in Description= without % escaping (cosmetic).

Other doors: parseSnapshotList time-order used elsewhere? check replication newest-common / snapshotsBehind. Gateway does no schema validation of schedule body (PRINCIPLES §6 both boundaries?).
Could not verify: real rollback order; recursive fire vs forced child rollback race; new panel vs old daemon strips fire fields silently (skew banner?).

## Pools and disks (daemon)

Coverage: pools-disks — 21 files in full; pve-storage.ts, zfs-list.ts partly; telemetry parsers (arcstats, diskstats, net-dev, zpool-iostat) outline only.

- **POOLS-DISKS-H1** DEFECT repro  services/pve-footprint.ts:418-424 (+ parsers/pve-storage.ts:298, :401) — failed `zfs list` (mountpoints null) drops every PVE `dir` storage from the footprint -> poolPveGate (pools.ts:1089-1105) opens: DELETE /pools/tank gives the ordinary destroy confirm, not 409 PVE_MANAGED; same for export, mountpoint, add/remove vdev. Trigger: one suspended pool hangs operand-less `zfs list`. Comment :413-416 accepts the loosening on purpose (contradicts :31-40). Fix: dir stanza present + null table => answer as unreadable config. SAME ROOT as shares M4 (sharePathClaim null).
- **POOLS-DISKS-H2** DEFECT repro (code path; lsblk premise unverified on a node)  routes/pools.ts:271-315 — destroy-cleanup calls a disk "exclusive" when its other partition shows no FSTYPE (lsblk cache, no PTTYPE asked), then `sgdisk --zap-all` whole disk (:3176): a raw partition used by a VM passthrough or LIO backstore loses its table entry. Attach pre-flight and AHR classifier use `blkid -p`. Fix: same blkid -p classifier; not blank or unreadable => shared.
- **POOLS-DISKS-M3** DEFECT repro  routes/scrub.ts:140-148 — failed `zpool status -jv` => every row "never scrubbed", running scrub reads idle. (invented-state class)
- **POOLS-DISKS-M4** DEFECT repro  routes/pools.ts:1657-1659, dashboard.ts:268-269, pools.ts:2248-2250 — failed `zpool list -j` reads "no pools" (GET /pools 200 [], dashboard pools not marked unavailable; GET /pools/import []; GET /pools/:name 404 for a live pool; collectDisks with failed status drops ZFS context -> FAULTED leaf healthy). listUnreadable exists (pools.ts:492-498).
- **POOLS-DISKS-M5** DEFECT repro  routes/scrub.ts:213 + services/scrub-schedules.ts:316-322 — two AHR periodic-scrub toggles for different pools race on the one anas-scrub unit: lost update (only last writer's pool). Fix: node-level exclusive lock key.
- **POOLS-DISKS-M6** DEFECT repro  routes/pools.ts:1282-1324 — raidzExpandGate has no degraded refusal (read model zfs-expansion.ts:154-178 has): direct POST widens a degraded raidz. Unverified whether OpenZFS refuses itself.
- **POOLS-DISKS-M7** DEFECT repro (ZFS output premise unverified)  routes/disks.ts:46-57 (:275) — stale kernel-named UNAVAIL leaf joined onto the NEW disk now holding that kernel name: blank replacement reads pool_member + critical, attach/replace refuse it.
- **POOLS-DISKS-M8** POSSIBLE  routes/pools.ts:1903-1952 — Upgrade offered on system pools; confirm says nothing about boot (legacy GRUB-on-ZFS). Needs operator ruling.
- **POOLS-DISKS-L9** NOTICED   pools.ts:143-153 — in-use hot spare shared with another pool wiped by cleanup.
- **POOLS-DISKS-L10** NOTICED  pools.ts:1424-1426 — cleanup disk lock keys use ZFS's by-id spelling, not inventory id.
- **POOLS-DISKS-L11** NOTICED  disks.ts:495-507 — GET /disks/:id/smart: probe failure reads "SMART not supported"; non-JSON => 500.
- **POOLS-DISKS-L12** NOTICED  zfs-expansion.ts:23-29 — detectLocalZfsVersion parses userland line, not kmod (harmless).
- **POOLS-DISKS-L13** NOTICED  disk-by-id.ts:29-46 — wholeDiskKernel('md127') -> 'md' (fails safe, wrong name).

Other doors: scrub-schedules.ts:91-99 failed zfs get => periodic scrub "On"; mounts.ts lexicalMountTargetReason: pool import has no live-mount collision gate.
Could not verify: OpenZFS attach to degraded raidz; lsblk FSTYPE for nested partition table / raw open; zpool status -j path+devid for swapped UNAVAIL leaf; smartctl NVMe smart_support; zpool upgrade rpool on legacy GRUB.

## Pools, disks, dashboard (panels)

Coverage: pools-panel (30-38, 40, 50, 15-gfx) — all reached; CSS and timeChart skimmed.

- **POOLS-PANEL-M1** DEFECT repro  38-pool-composer.js:1042 — Create composer deletes ALL whitespace from the mountpoint ("/srv/my pool" sent as "/srv/mypool"; daemon passes to zpool create -m, AbsolutePath allows spaces). Change-mount flow sends as typed. Same in 39-ahr-composer.js:762.
- **POOLS-PANEL-M2** DEFECT repro  50-dashboard.js:1454 (ZFS), :1064 (AHR) — every member disk tile hard-codes state 'online' (green tick) incl. a FAULTED/UNAVAIL leaf; telemetry carries no per-disk state. Fix: pass no state, or join leaf state.
- **POOLS-PANEL-M3** DEFECT repro  38-pool-composer.js:1187-1219 — multi-vdev "Add vdevs" = one job per vdev, no onFailed: failure midway leaves vdev 1 added (permanent on raidz), stale draft resends vdev 1, grid not reloaded.
- **POOLS-PANEL-M4** DEFECT repro  38-pool-composer.js:1262, 35-pool-attach.js:875 — pickers offer a hands-off disk (status==='available' only); daemon composableGate refuses at commit.
- **POOLS-PANEL-L5** DEFECT repro  38-pool-composer.js:335-337 — name rule accepts '.' and ':' (and says so); shared PoolName refuses -> 400.
- **POOLS-PANEL-L6** DEFECT/POSSIBLE 38-pool-composer.js:92,1055 — composer blocks single-disk log, daemon allows (DESIGN.md:1112 says log must be redundant: doc vs daemon); composer offers raidz for log/special/dedup, daemon isRedundantSpec accepts; OpenZFS likely refuses non-mirror -> job-time failure. Settle: `zpool create -n` on a node.
- **POOLS-PANEL-L7** DEFECT read   30-pools.js:1066-1073 — Scan column says "Scrubbing" for a resilver.
- **POOLS-PANEL-L8** NOTICED       unencoded sinks safe only by name grammar: 30-pools.js:601 held.detail tooltip, :875 upgrade confirmIntro, 40-disks.js:146 groupHeaderTpl, window titles 30:1387 31:187 34:208 35:809 38:1341 40:587.
- **POOLS-PANEL-L9** NOTICED       50-dashboard.js:1918-1924 — failed /v1/status blanks the warnings banner, keeps stale composite, toolbar says "just now".

Other doors: PoolName refuses '.', ':' which ZFS allows -> a hand-made pool tank.v2 400s on every /pools/:name (POSSIBLE). pools.ts:2246-2250 GET /pools/import returns [] on non-zero exit with empty stdout (failed scan reads "no importable pools").
Could not verify: zpool vs raidz for log/special/dedup; attach onto a leaf inside spare-N (35:650).

## Replication

Coverage: replication — 16 of 17 files in full; 65-replication.js ~1500 of 3442 lines (remotes manager window 1075-1550 and view assembly 3125-3442 not reached).

No C, no H.
- **REPLICATION-M1** DEFECT repro (daemon; ZFS side inferred from rrep.1a GT)  routes/replication.ts:436-445, 501-521 — single-dataset Replicate Once naming an OLDER snapshot the target already has: `discover` has no "target already has S" branch (planner has upToDate, replication-tree.ts:277); receive says "already exists; ignoring" exit 0; settleReplicationHolds moves the hold BACK to @S0 and releases @Sn on both sides, reports "incremental" success. Retention can then prune @Sn -> chain severed. Fix: treat target-has-S as up to date (send nothing, do not move the hold) or refuse a named snapshot older than newest common. Settle on node pair: 3 snapshots replicated, Once of the middle one, `zfs holds` both sides.
- **REPLICATION-M2** DEFECT repro  services/replication-remotes.ts:324-329 pinHostKey (routes/replication-remotes.ts:437) — pin job checks the one confirmed (ed25519) fingerprint but writes EVERY key ssh-keyscan returned into known_hosts; an unconfirmed RSA/ECDSA line gets pinned. Fix: write only the line(s) whose fingerprint equals the confirmed one (pin and re-trust).
- **REPLICATION-M3** POSSIBLE  services/replication-transport.ts:321 -> 65-replication.js:680-685, 853-856, 2908-2921 — remote `zpool list` lines returned with no PoolName check and loaded into combos using the default BoundList template (not {label:htmlEncode}); a compromised target could inject HTML into the PVE origin. Needed a browser check (settled above: the default list renders HTML). Fix: filter lines by PoolName at the source + encode in listConfig.tpl. Class applies to every combo fed from command output.
- **REPLICATION-L4** NOTICED  routes/replication.ts:658 vs 691-696 — recursive run claims cover the route's sweep, not the job's re-read sweep (R9).
- **REPLICATION-L5** NOTICED  routes/replication.ts:487-492, 795-800 — remote zfs recv stderr into job error + notification body verbatim, control chars not stripped (forged lines in mail body).
- **REPLICATION-L6** NOTICED  services/replication-units.ts:428 — LOCAL twin of the recorded "failed listing reads as everything behind"; comment at routes/replication-tasks.ts:94-96 wrong.

Could not verify: BoundList default encoding; M1 ZFS leg; M2 exploit leg (standard OpenSSH matching).
Clean: argv/remote quoting, unit files, fail-closed reads on the recursive path, holds across failure (recursive), R3/R5 at every door, PUT merge, no -F/-R/target destroy anywhere.

## Core, gateway, installers

Coverage: core — 45 of 48 files in full + CI workflows + packaging/ (install.sh, uninstall.sh, units; make-release.sh first 240 lines). No scripts/ dir exists.

No C, no H.
- **CORE-M1** DEFECT repro  gateway/src/proxy.ts:412 — cross-node forwarding trusts only the cluster CA (`new HttpsAgent({ca})`): a peer serving its own cert (pveproxy-ssl.pem, e.g. ACME) is unreachable -> 502 NODE_UNREACHABLE -> panel says "ANAS is not installed on this node". PVE half (pveproxy serves pveproxy-ssl.pem to peers) not run on a node. Fix: accept the cert pmxcfs holds for that node (chain to cluster CA or exact fingerprint of /etc/pve/nodes/<node>/pveproxy-ssl.pem).
- **CORE-M2** DEFECT repro  packaging/install.sh:722-729, 761-769 — failed-upgrade rollback leaves anasd, anas, anas-recycle.timer DISABLED (disable --now ... restart, never enable): runs until next reboot then never starts; installs units from the NEW release's UNIT_SRC; does not restore /etc/default/anas overwritten by --port.
- **CORE-M3** DEFECT repro  gateway/src/proxy.ts:169 — a PVE user id with a non-latin1 character: x-anas-user raw string -> ERR_INVALID_CHAR -> 502 "anasd unavailable", every view "not installed". Fix: percent-encode on the local hop, decode in readRequestAuthority.
- **CORE-L4** DEFECT repro  packaging/install.sh:15, 855 — `trap rollback ERR` without `set -E`: a failure inside a function phase1_install calls exits with no rollback. Fix: set -o errtrace.
- **CORE-L5** DEFECT repro (latent)  daemon/src/jobs/queue.ts:609-654, 695-697 — drain() not re-entrant: a body that releases/submits/throws before its first await -> nested drain -> job body runs twice. No current caller does.
- **CORE-L6** DEFECT read  pve-integration/src/20-notinstalled.js:215-220 — every non-403 health failure (401 expired ticket, 502, 503, 504, NODE_UNREACHABLE) renders "ANAS is not installed … install the release"; gateway has a distinct ANAS_NOT_INSTALLED code.
- **CORE-L7** NOTICED  packaging/uninstall.sh:222-229 — uninstall leaves mdadm.conf PROGRAM pointing at a deleted binary; removes cache-loss recovery for surviving AHR pools.
- **CORE-L8** NOTICED  gateway/src/auth/proxy-key.ts:381-386, AnasProxy.pm:57-61 — any www-data process can sign root@pam + Sys.Modify (WAVE2 F11 chose this knowingly; DESIGN sentence "nothing else but root can" inaccurate). Operator's call.
- **CORE-L9** NOTICED  rulings conflict: read jobs on Sys.Audit (cr.67) vs cr.62 reader bound on fs/browse: PBS catalog browse and cloud preview inline arm (any local source) run on Sys.Audit. Operator's call.
- **CORE-L10** NOTICED  packaging/make-release.sh:236 — release smoke boots the real daemon, not --mock (as root on a node it runs boot scan / quarantine beside the live anasd).
- **CORE-L11** NOTICED  gateway/src/proxy.ts:172-173 — stale comment.

Other doors: shares-smb.ts:487 SMB global interface-binding confirm signs only {section:'global'} (ruling 2026-10-17: a confirm signs the names of every field it writes); ahr cache-event route: unplugging any disk carrying a partition labelled like a pool's cache slice fires the rule (check it acts only when the cache PV is really missing).
Could not verify: pveproxy-ssl.pem to peers; non-latin1 user on a node; packaging/uninstall.sh restarts pveproxy at step 2 before removing timers/units (web-shell uninstall dies there).
Clean: confirm-code binding, cancel auth, gateway HMAC/assertion, socket 0600, executor argv/deadlines, lock table, splice gating, config-writer, CI/release pinning.

## AHR core

Coverage: ahr-core — 28 files in full, 8 in part, 11 NOT reached (routes/ahr-mutate.ts 1212-1763 scrub/repair routes; services ahr-layout, ahr-cache-state, ahr-io, partition-device, udev-settle; parsers btrfs-subvol-list, btrfs-usage, dmsetup, lvm-report).

- **AHR-CORE-H1** DEFECT repro  routes/ahr-mutate.ts:652, :673 + services/ahr-create.ts:513-535 (destroy.ts:333,340,350) — create with the DEFAULT mountpoint runs no collision gate and takes no mount lock; if another pool was moved to /mnt/anas-ahr/<name>, the job wipes disks, builds, mkfs, then fails at hasMount and its rollback UNMOUNTS whatever is mounted there and removes every fstab line at that path — the other pool's. Same rollback after any failure past the first wipefs. Fix: gates + mount lock for the default path; rollback unmounts only a mount whose source is this pool's LV and removes only lines it wrote.
- **AHR-CORE-M2** DEFECT repro  routes/ahr-expand.ts:116-150 + services/ahr-expand-resume.ts:104-108 — expand/replace accept the pool's own hot spare (or cache disk) as an added disk; executor detaches the spare then grow fails (mdadm refusal mocked) -> band silently loses its spare; Replace with newDiskId=spare promotes spare to member (ruled OUT). Fix: refuse any addDisks/newDiskId in pool.disks. (ahr-panel L6 offers exactly these.)
- **AHR-CORE-M3** DEFECT repro  services/ahr-fstab.ts:110 — readAhrPoolLine takes the first line whose spec is the pool's LV; the Previous Versions `@snapshots` line has the same spec and comes first after a Change mountpoint -> snapshot-rollback remount / Remount verb mount the pool `-o ro,subvol=@snapshots`; boot cache rung mounts the wrong line. Identity audit #30 records the change-mountpoint cause; these readers are new doors.
- **AHR-CORE-M4** DEFECT repro  services/ahr-create.ts:374-375 + ahr-mdadm-conf.ts:113 — a foreign PROGRAM line in mdadm.conf makes every create fail AFTER wipe + array build (MdadmForeignProgramError not gated up front).
- **AHR-CORE-M5** DEFECT repro  services/ahr-topology.ts:540-557, 784-791, 1000-1001 — exit codes of vgs/lvs/pvs/ls by-id/lsblk/findmnt never checked: failed vgs => pool state `failed`, critical card "has FAILED — LVM layer missing"; failed by-id => kernel names into destroy's disk locks; failed lsblk => 0 partitions. (invented-state class; ahr.r1 covers only mdadm --detail)
- **AHR-CORE-M6** POSSIBLE  services/ahr-snapshots.ts:443-464 — rollback failing after the mv of @data leaves the pool unmounted, @data renamed away, real error replaced by the finally's mount error. Not run.
- **AHR-CORE-L7** POSSIBLE  ahr-boot-scan.ts:229-259 — GT-8 ladder trigger = an incremental assembly still waiting for a slow disk; runs --run --readwrite (degraded) and names a reshape it never read.
- **AHR-CORE-L8** DEFECT read  ahr-destroy.ts:216-217, 460-466 — unreadable lsblk at destroy => disks silently not zapped, job says destroyed.
- **AHR-CORE-L9** DEFECT read  ahr-identity.ts:98-99 -> ahr-destroy.ts:521-527 — unreadable mdadm.conf = "no pins" -> unpin skipped silently.
- **AHR-CORE-L10** DEFECT read ahr-expand-exec.ts:351-369 — failed lsblk label scan => resolveDiskNumber max=0 => joining disk gets ordinal d1 (duplicate labels).
- **AHR-CORE-L11** POSSIBLE  ahr-cache.ts:651-659, 717-727 — detach wipes any <pool>-cache<n>-labelled slice not a PV of another VG, without probing content.

Other doors: share-selfservice.ts:240-260 the @snapshots fstab line reuses the pool's LV spec (root of M3); does Mounts refuse targets under /mnt/anas-ahr/ ? (second way into H1).
Could not verify: mdadm's real answer for M2 (stunt node); boot ladder vs slow HBA; btrfs failure modes after mv.

## AHR (panels)

Coverage: ahr-panel (39-ahr.js, 39-ahr-composer.js) — both read in full.

- **AHR-PANEL-M1** DEFECT repro  39-ahr.js:775-776, 980-987 — spare/replacement rows counted as band members: healthy pool reads "raid5 x 5 (4 in sync)", band legend usable 16 TiB vs Capacity block 12 TiB. Daemon filters spares (ahr-topology.ts:1254, ahr-expand.ts:116). Fix: count non-spare rows in arraysHtml + poolBands.
- **AHR-PANEL-M2** DEFECT repro  39-ahr.js:833-840, 264-301, 401-417 — unmounted pool shown "mounted at /dev/<pool>/<pool>-vol, 0 B used, 0 B free"; grid Used/Free 0; change-mount prefills the LV path. Schema ahr.ts:473 says check `mounted`. Fix: gate on mounted===true, say "not mounted — usage unknown".
- **AHR-PANEL-M3** DEFECT repro  39-ahr.js:326-330, 1719-1727 — during the btrfs phase of a scrub the grid says healthy / Idle and Scrub is enabled (409 on click). Root in daemon ahr-topology.ts:963-1021 (state ladder does not read btrfs scrub status). scrub.r2 covered the Scrubs row only.
- **AHR-PANEL-L4** DEFECT repro  39-ahr-composer.js:762,784,796 — "Mount at" strips whitespace silently (typed "/srv/media pool" sends "/srv/mediapool"); confirm never names the mountpoint.
- **AHR-PANEL-L5** DEFECT repro  39-ahr-composer.js:828; 39-ahr.js:2084,2376,3134,3282 — pickers filter on status==='available' only and offer a hands-off (iscsi-served-here) disk; daemon refuses at every door (isComposableDisk). Wrong offer, not wrong act. Same in 38-pool-composer.js:1262.
- **AHR-PANEL-L6** DEFECT repro  39-ahr.js:3144-3152, 3269-3273 — expand wizard / Replace take every disk incl. spare and cache as a member (cache SSD painted with bands; daemon 400 "is not a member").
- **AHR-PANEL-L7** NOTICED       39-ahr.js:3057 + ahr-expand.ts:246 — expand confirm names no disk to be wiped.
- **AHR-PANEL-L8** NOTICED       39-ahr-composer.js:61-66 — nameValid allows 255, schema caps at ahrMaxPoolNameLength (29 for 1-9 disks).
- **AHR-PANEL-L9** POSSIBLE      39-ahr.js:1660 — held.detail unencoded into setTooltip (also 30-pools.js:601, 60-datasets.js ~950); needs a browser probe whether QuickTip renders HTML.

Other doors: ahr-topology.ts:873-887 mounted pool whose btrfs usage read fails reports 0 used/free (schema has no unknown). 10-api.js:915 confirm drops the 409 headline = already in EPICS.
Could not verify: QuickTip HTML; whether Expand is admitted mid btrfs scrub.

## AHR scrub and self-heal

Coverage: ahr-heal — 10 files in full; ahr-scrub.ts lines 180-520 and 880-1930 in full, rest skimmed; bin/selfheal-mirror.ts, bin/selfheal-repair.ts NOT reached (dev-only: make-release.sh:163 removes the bins).

- **AHR-HEAL-H1** DEFECT repro  services/selfheal-repair.ts:1229-1235 + ahr-repair.ts:352-357, 406-418 — any non-verdict failure ends "unrepairable — restore this file from backup": (A) AFTER the block was written and arbitrated, a post-check that does not settle in 180 s (md check `delayed`) throws a plain Error; `written` consulted only for ForeignSyncOpError (1219); (B) BEFORE any write, a csum leaf unreadable (D3) / tree-walk / member-read / pin failure takes the same path. Fix: classify by phase: after written => repaired with confirmation skipped; before => not-examined with reason; repairAhrFiles never maps a thrown block to restore advice.
- **AHR-HEAL-H2** DEFECT repro  services/ahr-mirror-reconcile.ts:745-779 (state.nodes keyed by nodeLogical only), :1110 — arm B reuses a METADATA|DUP node's verdict across both DUP copies (logicalForMdByte ignores `copy`, selfheal-map.ts:1312-1314) and WRITES A ROTTEN ROW OVER THE GOOD ONE, reports reconciled. Fix: key on (logical, copy) or the node's md byte; verify the node at the location being written.
- **AHR-HEAL-H3** POSSIBLE (missing guard reproduced in a constructed race)  ahr-mirror-reconcile.ts:1073-1110 — arm B writes row bytes read at T0 with no re-read before the write, no pin, csum from the run-long cache (ctx.csums; verifyNode checks neither owner nor generation): extent recycled in the window => old row over new live data. Fix: re-read both legs right before writeDirect and require equality with T0; uncached csum for a row about to be written.
- **AHR-HEAL-H4** POSSIBLE  selfheal-repair.ts:444-448, 523-529, 551-554; selfheal-reconcile.ts:245-253 — sync_max narrowed to one stripe is left in place when md starts a FOREIGN op (member fails mid-check, spare takes over): recovery pauses at sync_max forever, array stays degraded. Kernel pause from memory. Fix: under a foreign op still write sync_max=max (never sync_min, never idle). SETTLE LIVE: narrow window, fail a member with a spare, watch sync_completed.
- **AHR-HEAL-M5** POSSIBLE  selfheal-map.ts:190-203 memberHasBadBlock (leaf H5) — bad-block ranges compared in data-area coordinates; kernel records absolute member sectors (data_offset): covered row reads false, row data_offset further reads true. No GT capture for H5. SETTLE LIVE: rd<n>/bad_blocks with an injected range.
- **AHR-HEAL-M6** POSSIBLE  selfheal-repair.ts:1629-1646, 1199-1201 — flat pool: a file in a nested subvolume is neither pinned nor readable through the pin (snapshot does not recurse) -> correct write then "unrepairable: still reads back with an error" (ENOENT counted as bad).
- **AHR-HEAL-L7** NOTICED  selfheal-repair.ts:1104-1114 — read-back guard runs after precheck and arbitration (should be straight after reverify).
- **AHR-HEAL-L8** NOTICED  selfheal-map.ts:1071 — unreadable rd<n>/offset of a present member becomes data offset 0 (throw band-unreadable).
- **AHR-HEAL-L9** NOTICED  selfheal-map.ts:196-198, 206-213 — unreadable bad-block list (null) treated as clean; parity rewrite proceeds silently.
- **AHR-HEAL-L10** NOTICED selfheal-map.ts:1302-1318, ahr-mirror-reconcile.ts:1039 — reverse map wrong when one md has several dm segments (after expansion): rows come out unresolved, never a wrong write; latent.
- **AHR-HEAL-L11** NOTICED selfheal-io.ts:189 — staged payload named <pid>-<byteOffset>: two long-lane jobs on different pools writing the same offset swap payloads. Fix: mkdtemp / counter.
- **AHR-HEAL-L12** NOTICED ahr-mirror-reconcile.ts:1077 — one URE in a 4 MiB leg window throws out of reconcileMirrorBand: job fails with no result, no notification.

Other doors: routes/scrub.ts:267 btrfsScrubRunning null on failed/slow read => "not running".
Could not verify: btrfs dump-tree -b page-cache staleness; kernel bad_blocks coords; recovery pause at sync_max.
Clean: RAID5/6 placement arithmetic vs kernel (23,256 samples, 0 disagreements); every data write goes through md; pre-write re-checks; knobs restored; argv.

## iSCSI

Coverage: iscsi — all 19 files reached; 75-iscsi.js renderers, sinks, dialogs, handlers in full, LUN window layout and backup-coverage menu skimmed.

- **ISCSI-H1** DEFECT repro  services/iscsi-ownership.ts:346 (+ services/iscsi.ts:623-703) — on a ZFS-ROOT node an AHR image LUN whose AHR pool did not mount: the 0-byte placeholder sits on `/` = rpool/ROOT/pve-1; deriveOwnership checks pveOwnership BEFORE backingExists:false -> target becomes foreign/backing-pve-storage -> F2 placeholder quarantine skipped (iscsi-quarantine.ts:228), health not degraded (iscsi-health.ts:291): an EMPTY disk with the right serial keeps being served. (Interaction with this release's #85 matchMountpoint gate.) Fix: absent/stub backing must not take PVE ownership from the dataset it falls through to; or classify file LUNs on an ANAS-IQN target by AHR fstab mountpoint first. Live check: iscsi.8 F2 recipe on the ZFS-root stunt node.
- **ISCSI-H2** DEFECT repro  services/iscsi.ts:544-545 — read layer builds every target from tpgs[0] only: (a) a hole in tpg2 not in missingLuns -> degraded=false -> next saveconfig drops that LUN; (b) claimsFromTargets (iscsi-mutate.ts:1637) has no claim for a tpg2 LUN -> rollback/rename/shrink of its zvol not refused (findLunHolder walks all TPGs: divergence); (c) target delete gates (iscsi-guard.ts:169-191) blind to a hand-added tpg2 session -> session dropped. Also served serials (iscsi-held.ts:285-303). Fix: read every TPG, or refuse to mutate a target with >1 TPG and degrade on holes in any.
- **ISCSI-M3** DEFECT repro  services/iscsi-mutate.ts:1591-1616 — LUN delete unmaps + deletes backstore BEFORE destroying backing, saves at the end: a failed zfs destroy/unlink leaves a missingLun -> node degraded, every mutation refused, Repair would recreate the LUN. zvolSnapshotNames gate (iscsi-guard.ts:370-379) fail-open on failed zfs list. Same shape resizeFileLun :1457-1503. Fix: unmap -> delete backstore -> saveconfig -> destroy backing; failed destroy = "LUN deleted, backing kept: <reason>".
- **ISCSI-M4** DEFECT repro  routes/iscsi-mutate.ts:459 — "initiator could never log in" check only when the PUT carries acls: {auth:'chap'} alone locks out every initiator silently (75-iscsi.js:1741-1749 sends that); mutual-CHAP -> CHAP silent no-op (iscsi-mutate.ts:664-671).
- **ISCSI-M5** DEFECT repro (fake executor)  routes/iscsi-mutate.ts:840-859, :219-230, iscsi-guard.ts:198-205 — add-LUN undo can delete a pre-existing unmapped backstore of the same name (backstoreTouched set before create; lunNameFreeGate checks LUN names only). Caveat: undo uses the object-level `/backstores/<plugin>/<name> delete`, GT-42 proves only the parent form (backup-restore.ts:1191 uses the same) — node command settles. Also createSparseImage (:809) before the try leaves the image on failure.
- **ISCSI-M6** POSSIBLE  iscsi-mutate.ts:1594-1595 + iscsi-guard.ts:407-414 — LUN delete deletes the backstore by name, session gate looks only at this LUN's initiators; same backstore mapped in another target with a live session (rtslib cascade unverified).
- **ISCSI-L7** NOTICED  iscsi-repair.ts:150, iscsi-health.ts:291 — a hole on a FOREIGN target degrades the node and Repair then recreates on that hands-off target. NEEDS A RULING.
- **ISCSI-L8** DEFECT read  iscsi-mutate.ts:454-458 — degraded refusal says "restart rtslib-fb-targetctl" (drops every session; iscsi-repair.ts:21-29 says ANAS never does it); should name Repair.
- **ISCSI-L9** DEFECT read  routes/iscsi-mutate.ts:361 — "target name exists" guard compares the full IQN incl. yyyy-mm: same display name next month.
- **ISCSI-L10** NOTICED  targetcli joins argv with spaces and re-parses: dev=/dev/zvol/<backing>, file_or_dev=<dir>/<name>.raw (iscsi-mutate.ts:1236, 1242), stored udev_path in resize/repair unvalidated against that grammar (space, '=').
- **ISCSI-L11** DEFECT read  services/pve-firewall.ts:52, 239-245 — advisory only ever checks port 3260.
- **ISCSI-L12** POSSIBLE  shared/schemas/iscsi.ts:892-911 — CHAP user/secret starting "NULL" (kernel prefix compare, unverified).
- **ISCSI-L13** DEFECT read  iscsi-mutate.ts:675-691 — edit deletes removed portals before creating new ones (failed create = no listener).
- **ISCSI-L14** NOTICED  routes/iscsi-mutate.ts:1353-1360 — parseLunIndex uses Number(): ' ', '0x1', '1e0' accepted.
- **ISCSI-L15** NOTICED  parsers/lio-saveconfig.ts:381-398 — unreadable/unparseable saveconfig.json reads as null = "nothing persisted" -> no holes, next mutation overwrites.

Other doors: backup new-LUN restore releases the iSCSI lock during the stream (backup-restore.ts:1026-1043): another verb's saveconfig persists the half-restored LUN; failed restore cleanup leaves a missingLun.
Could not verify: targetcli object-level delete; rtslib cascade; kernel NULL prefix; zfs destroy vs udev race; F2 on the ZFS-root node.

## Remote mounts

Coverage: mounts — 9 daemon/shared files in full; 67-mounts.js mostly in full (buildOptionList 1274-1455, static tier configs, view shell skimmed).

- **MOUNTS-H1** DEFECT repro (daemon half; title render not run in a browser)  67-mounts.js:2161 + parsers/findmnt.ts:312-317 — the Edit window title carried the mountpoint unencoded (window titles are HTML), and classifyKind fell back to the SOURCE SHAPE: a local user without privilege could mount a FUSE filesystem whose source looks like a remote export and whose mountpoint path carries markup; it listed as a remote NFS share, and opening it for Edit ran script in the administrator's PVE session. Same unencoded-title pattern: 69-snapshots.js:1014,1968; 65-replication.js:1710,1942; 68-backup.js:3503,4989; 75-iscsi.js:1103; 40-disks.js:587; 70-shares.js:1882. Fix: enc() every title; classify remote by fstype only.
- **MOUNTS-H2** POSSIBLE  routes/mounts.ts:384-385, :1346 — Edit (PUT) unmounts in remountEntry but lunGate runs only for unmount/disable/remove: editing a mount that holds an iSCSI fileio image yanks it. Premise (umount succeeds while LIO holds the image) needs the iscsi.6 GT run.
- **MOUNTS-M3** DEFECT repro  parsers/fstab.ts:50/658 (FIELD_SPLIT=/\s+/, .trim()), :65 vs shared/formats/fstab.ts:47 — reader splits on ALL Unicode whitespace, libmount on ASCII blanks, writer escapes only space/tab/newline/backslash: a CIFS share with U+3000 or a mountpoint with NBSP is written but cannot be read back -> Remove leaves the line (job says removed), Edit 404, second create duplicates the line and overwrites the first mount's credentials file.
- **MOUNTS-M4** DEFECT repro  routes/mounts.ts:342-387, 1344-1372 — editing a DISABLED line mounts it (no disabled gate on update; panel gate bypassed by row double-click 2930-2934).
- **MOUNTS-M5** DEFECT repro  parsers/fstab.ts:741/794/1163, routes/mounts.ts:917-919 — credential rotation on an `smb3` fstype line "completes" but the line keeps the old credentials file; new file orphaned; detail says credentials not set. Same orphan for credentials sent on an NFS entry.
- **MOUNTS-M6** DEFECT repro  routes/mounts.ts:1326-1332 doMount, parsers/fstab.ts:1110-1121 — Mount verb on a hand-written CIFS line with an inline password drops the password (lifted, never re-emitted) -> mount.cifs prompts on an open stdin pipe -> hang to deadline. Regression from cr.52r D3.
- **MOUNTS-M7** POSSIBLE  services/mounts.ts:1113-1132 — Test probe dir removed with rm recursive+force in finally; umount result ignored, no umount on timeout 124: if the share is still mounted Node's rm walks into the LIVE remote share and deletes what the credentials allow. Fix: rmdir only, never recurse. (HIGH consequence; treat as must-fix regardless of proof.)
- **MOUNTS-L8** DEFECT repro  shared/mount-target.ts:62-76, services/mounts.ts:1117 — NFS server beginning with `-` reaches `mount -t nfs4 -o … <spec>` with no `--` in probeMountSpec (Sys.Modify).
- **MOUNTS-L9** DEFECT repro  67-mounts.js:1592-1601, 2535-2537 — Test from Edit of a credentialed CIFS mount always fails unless password retyped (credentials:{username} refused).
- **MOUNTS-L10** DEFECT repro  findmnt.ts:312-317, routes/mounts.ts:279-286 — fuse.sshfs/glusterfs/davfs classed nfs; mutation verbs act on them.
- **MOUNTS-L11** NOTICED  routes/mounts.ts:415-418, 737-740 — non-persistent CIFS create writes a credentials file Remove never deletes.
- **MOUNTS-L12** NOTICED  parsers/fstab.ts:162-175 — untouched save of a hand-written line rewrites it canonically.
- **MOUNTS-L13** NOTICED  67-mounts.js:666-675 vs routes/mounts.ts:382-383 — armed automount row offers Unmount -> 404.
- **MOUNTS-L14** NOTICED  routes/mounts.ts:1207-1215 — removeMountpointDir rmdirs the textual path with no mountTargetRefusal (/home, /srv on a hand-written line).
- **MOUNTS-L15** NOTICED  shared/schemas/mounts.ts:486-511 — extraOptions accepts x-systemd.required-by=local-fs.target etc. (defeats nofail -> emergency mode on a dead server).
- **MOUNTS-L16** NOTICED  routes/mounts.ts:1081-1083, 1182-1184 — failed `umount -l` ignored: reports disabled/removed while still mounted; Remove already deleted the credentials file.
- **MOUNTS-L17** NOTICED  67-mounts.js:712 lunTip unencoded tooltip; :2624 submitMount trims the mountpoint used in the PUT path.

Other doors: executor/prod.ts:422 stdin is an open pipe by default (any prompting tool waits for the deadline); SingleLine/AbsolutePath refuse only C0/DEL (check smb.conf/exports parsers for the same \s mismatch).
Could not verify: armed automount Edit; `guest` added to sec=krb5 lines; H2 premise; systemd mount argv; mount.cifs without a TTY.

## Cross-cutting: values shown as state that no read supplied

Coverage: invented-state — cross-cutting sweep: 2,732 candidate lines; every state literal, switch default, placeholder zero and shared default judged; ~900 panel `|| ''` formatting defaults and ~520 daemon defaults with no state word judged by filter only.

- **INVENTED-STATE-H1** DEFECT repro  routes/dashboard.ts:281-292, 296-310, 320-340, 244-253 (same pattern task-units.ts:1309, snapshot-schedule-units.ts:728, iscsi-warnings.ts:236, mounts.ts:387) — every /v1/status collector except AHR catches its own failure and returns the EMPTY shape as a successful read; readDashboardSection (:691) marks unavailable only on throw/timeout: failed `zpool list -j` => "No pools", no warning cards, a DEGRADED pool's critical card disappears; failed `zpool status -jv` => a FAULTED disk counts healthy. Fix: collectors throw on a failed read (listUnreadable, pools.ts:492) so the section is unavailable. [owner: pools-disks; mounts.ts:387 -> mounts; iscsi-warnings.ts:236 -> iscsi; task-units.ts:1309 -> backup; snapshot-schedule-units.ts:728 -> datasets]
- **INVENTED-STATE-H2** DEFECT repro  routes/dashboard.ts:519 — telemetry fills a vdev's `state: info?.state ?? 'ONLINE'` and `role ?? 'data'` when the zpool status join fails: green ONLINE pill (50-dashboard.js:1543) on a vdev that may be FAULTED. dashboard.test.ts ~:118 pins the invented value. Fix: VdevTelemetry.state optional; render no pill / unknown. [pools-disks + pools-panel]
- **INVENTED-STATE-H3** DEFECT repro  services/ahr-topology.ts:549/556, 864-866 — findmnt exit code unchecked: an AHR pool btrfs put READ-ONLY after an I/O error reports state=healthy, mountedReadOnly=false, no advisory. [ahr-core]
- **INVENTED-STATE-M4** DEFECT repro  ahr-topology.ts:543-544, 860, 999-1000 — vgs/lvs exit codes unchecked: `failed` + "volume group not found" with a pin; pool VANISHES without a pin. (= AHR-CORE-M5) [ahr-core]
- **INVENTED-STATE-M5** DEFECT repro  services/replication-units.ts:377-387 (421-447) — failed LOCAL target listing => never replicated, every snapshot behind. (= REPLICATION-L6) [replication]
- **INVENTED-STATE-M6** DEFECT repro  70-shares.js:250-252, 389-397 — Shares grid "Active" column is ALWAYS 0: GET /shares/smb (routes/shares-smb.ts:429-441) sends neither activeConnections nor connections; normSmb falls back to 0. Fix: send the count or render a dash when absent. [shares]
- **INVENTED-STATE-M7** DEFECT read  routes/scrub.ts:140-148 — (= POOLS-DISKS-M3) [datasets]
- **INVENTED-STATE-M8** DEFECT read  routes/pools.ts:1750-1768 (GET /pools/:name), :2745 (expansion), :1655-1658 (GET /pools) — failed read => 404 "not found" / []. (= POOLS-DISKS-M4) [pools-disks]
- **INVENTED-STATE-M9** DEFECT read  routes/datasets.ts:445-450, 1913-1927 — failed snapshotNames reads as no snapshots: the dataset-destroy confirm omits "N snapshot(s) will also be destroyed" (recursive destroy understated). [datasets]
- **INVENTED-STATE-M10** DEFECT read  services/mounts.ts:399-401 (GET /mounts routes/mounts.ts:581, detail, dashboard) — unreadable findmnt table => '' => every fstab mount reads unmounted, others vanish. [mounts]
- **INVENTED-STATE-L11** DEFECT read  routes/dashboard.ts:449-452, 658-667 — unreadable arcstats => ARC 0%, 0 B / 0 B under "Live telemetry · just now". Fix: arc nullable. [pools-disks + pools-panel]
- **INVENTED-STATE-L12** DEFECT read  routes/pools.ts:1707, 1711, 1712 — failed probe => scanRunning false, trimSupported false, upgradeAvailable false. [pools-disks]
- **INVENTED-STATE-L13** POSSIBLE  routes/shares-smb.ts:286-304, 475-477 — (= SHARES-L8) [shares]
- **INVENTED-STATE-L14** DEFECT read  68-backup.js:4135, 4659, 4899 — repo-test stage defaults to 'ok' when absent ("verified — you can save"); any request error stored as 'tcp'. (= BACKUP-PANEL-L8 + new) [backup-panel]
- **INVENTED-STATE-L15** DEFECT read  routes/datasets.ts:430-432, 1351 — failed zfs list => GET /pools/:name/datasets empty: an existing pool shows "no datasets". [datasets]

TABLE — state fields that cannot say "unknown" although the read behind them can fail:
| shared/schemas/dashboard.ts:263 VdevTelemetry.state | 'ONLINE' (dashboard.ts:519) | 50-dashboard.js:1536-1550 |
| dashboard.ts:261 VdevTelemetry.role | 'data' (:518) | vdevRoleLabel |
| dashboard.ts:224-229 ArcTelemetry.* | 0 (:451, :663) | 50-dashboard.js:845-864 |
| dashboard.ts:53 DiskHealthCounts.* | 0 (:298-308) | Disk Fleet tiles |
| dashboard.ts:63-64 ShareStatusBrief.smbCount/nfsCount | 0 (:322-339) | shares brief |
| dashboard.ts:48 PoolStatusBrief.scanRunning | false (:281) | dashboard pools |
| zfs.ts:231 PoolSummary.scanRunning | false (pools.ts:1707) | pools grid |
| zfs.ts:238, :243 trimSupported, upgradeAvailable (.default(false)) | false (pools.ts:1711-1712) | Trim / Upgrade |
| ahr.ts:513 AhrPool.state | failed / healthy on failed reads (ahr-topology.ts:999-1028) | 39-ahr.js, dashboard |
| ahr.ts:496 AhrPool.mountedReadOnly | false (:864) | Remount gating |
| ahr.ts:502-503, :510 vg.sizeBytes/freeBytes, lv.sizeBytes | 0 (:1047-1053) | 39-ahr.js |
| ahr.ts:250, :252 AhrCapacity.usedBytes/freeBytes | 0 | 39-ahr.js |
| ahr.ts:343 AhrCache.state (no unknown) | absent when lvs failed (ahr-cache-state.ts:240) | 39-ahr.js:880-897 |
| disks.ts:8 Disk.status (no unknown) | other/available for a ZFS member when zpool status fails (lsblk.ts:103-119) | 40-disks.js |
| schedules.ts:665 PeriodicScrubState.lastScrub (null = never only) | null (scrub.ts:142-147) | "never scrubbed" |
| replication.ts:317 snapshotsBehind (null unused locally) | N (replication-units.ts:446) | "N behind" |
| (missing) activeConnections on GET /shares/smb | 0 (70-shares.js:252) | Active column |
Also: Disk.healthStatus has unknown, but computeHealth (disks.ts:173-185) answers healthy from SMART alone when the ZFS context could not be read.

Clean: gfx primitives, Disks panel health, last-run pills on every task grid, PVE ownership config-unreadable, AHR md layer (throws), AHR cache counters, iSCSI carriedByInterface null, share-path probes, mount guards' tableUnreadable, cloud preview counts.
Could not verify: iSCSI sessionCount when an ACL's configfs info is unreadable; shared/schemas/cloud.ts:438-441 doc claim about sub-second runs.
