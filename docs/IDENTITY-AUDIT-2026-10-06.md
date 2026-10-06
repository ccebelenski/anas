# Identity and lifecycle audit — 2026-10-06

**Status:** read-only audit at main 85fb5e8 (0.4.2 release commit), operator-ordered after the
0.4.2 reviews kept finding identity bugs. Nothing here is fixed by this document; it is the
evidence for the identity epic candidate in EPICS §4. Paths are relative to
`packages/daemon/src` unless stated.

## Cross-cutting patterns

- **P1. Confirm codes and queued jobs are keyed by name, and the job never re-checks.**
  `safety/confirm.ts` binds a code to the operation plus params that are always names or
  indexes (`{pool}`, `{dataset}`, `{snapshot}`, `{target, lun index}`, `{name}`); `ahr.create`
  binds only `{name}` and leaves out the disks it wipes. The job queue runs 4 jobs at once, so
  a confirmed destructive job can sit queued for hours behind scrubs and backups, then acts on
  whatever carries that name when dequeued. `PoolDetail.guid` and the LUN serial exist in the
  schemas; no route keys on them.
- **P2. "Ours" is inferred from a name pattern.** `anas-<bucket>-<stamp>` snapshots, the
  `anas-repl` hold tag, `<pool>-d<n>-b<band>` and `<pool>-cache<n>` GPT labels, `<pool>-r<N>` md
  names, `host/<backupId>` PBS groups, `<mountpoint>.cred` files. Nothing stamps ownership with
  a property, uuid or tag at creation time.
- **P3. Name-keyed shadow state outlives its object.** AHR intent `/etc/anas/ahr/<pool>.json`,
  the AHR scrub pool-name list, schedule targets, `zfs-import@<name>`, cluster-wide registries
  against per-node secrets, in-memory `jobQueue.findByOperation(…, name)`.

## Findings, worst first

### Data loss: destructive verb keyed on a derived or inferred identity

1. **Snapshot retention prunes any `anas-<bucket>-<stamp>` snapshot; a bucket absent from the
   policy keeps 0** (`snapshot-retention.ts`, `snapshot-schedules.ts`). Two schedules on one
   dataset with the "standard" and "minimal" presets: every minimal fire destroys all hourly and
   monthly snapshots except the newest. Received replication snapshots and hand-made `anas-*`
   names are pruned too; `SnapshotName` reserves nothing. The schedule is captured at request
   time, so a queued fire prunes with the old retention or after deletion. Targets are names,
   not guids: a destroyed-and-recreated or received `tank/media` is re-adopted. **Fix:** stamp
   ownership at take time (`zfs snapshot -o anas:schedule=<id>`; a btrfs equivalent for AHR);
   prune only this schedule's stamped snapshots (legacy unstamped only where exactly one schedule
   targets the dataset); re-read the schedule in the job; store the target guid; reserve the
   `anas-` prefix on manual create/rename.
2. **Pool destroy with "Clean up disks" wipes the whole disk for any leaf path that is neither
   by-id nor `/dev/sdX`** (`routes/pools.ts:143-149, 2070`). by-partuuid / by-path / by-vdev leaves
   fall back to `/dev/disk/by-id/<disk.id>` with `-partN` stripped → `wipefs -a --force` on the
   whole disk before the shared-disk guard. A stale kernel path on a non-ONLINE leaf hits another
   disk after a reshuffle (labelclear, wipefs, `sgdisk --zap-all`). **Fix:** use `disk.path` for
   non-kernel paths; skip non-ONLINE leaves; capture the pool guid and require `blkid -p -s UUID`
   on each leaf to match before wiping.
3. **AHR create and spare-attach check disk availability at request time; a failed create's
   rollback zaps a disk that was never ours** (`ahr-create.ts:341-351`, `ahr-destroy.ts:306`,
   `ahr-spare.ts:181`). **Fix:** re-run `collectDisks`/`isComposableDisk` in the job; add a disk
   to `planned` only after its own wipe succeeds.
4. **AHR destroy, cache detach and cache attribution pick disks by GPT label pattern**
   (`ahr-destroy.ts`, `ahr-cache-state.ts`, `ahr-cache.ts`, `routes/ahr-cache.ts:163`); same-named
   md arrays from another pool merge into one (`parsers/mdadm-detail.ts`, `ahr-topology.ts`,
   `ahr-expand-exec.ts`); create does not refuse an occupied name. **Fix:** act only on partitions
   whose `mdadm --examine --export` UUID is pinned/live for this pool; a cache slice is ours only
   as a PV of this VG's UUID; once pinned, admit only pinned UUIDs; create refuses an occupied name.
5. **The boot recovery ladder force-starts any inactive `*-r<N>` array** (`ahr-boot-scan.ts:157-189`)
   with no ownership gate. **Fix:** only pinned UUIDs or arrays whose VG exists with that md as PV.
6. **The AHR expansion intent is keyed by pool name and survives destroy** (`ahr-intent.ts`);
   resume has no confirm and drives the predecessor's disks with `requireAvailable=false`;
   `ensureDiskPartitions` can write a GPT over a disk that became a Ceph OSD. **Fix:** destroy
   clears the intent (409 while running); the intent stores md/VG UUIDs; resume re-checks disks
   and confirms.
7. **AHR spare removal can `--fail` an active member** (`ahr-spare.ts:252-263`, never checks
   `m.spare`). **Fix:** act only on members mdstat flags `(S)` at job time.
8. **An iSCSI zvol LUN is identified by its `udev_path` string** while the size check reads the
   served device (`iscsi-configfs.ts:534`, `iscsi.ts:594`). Rename + recreate under a live LUN →
   a "grow" shrinks the new zvol; delete with `destroyBacking` destroys the new zvol; repair
   recreates from the stale path. **Fix:** compare the served device's rdev with the path's rdev
   before any zfs verb or repair; re-read volsize in the job.
9. **LUN delete confirm is bound to `{target, lun index}`, indexes reused lowest-free**
   (`iscsi-mutate.ts:1178`). **Fix:** bind serial + backstore; re-read under the lock.
10. **Whole-image restore writes to the backing path captured at request time**
    (`backup-restore.ts:598`); only sessions are re-checked; confirm omits snapshot and archive.
    **Fix:** under the lock require same serial, path and size; bind serial + snapshot + archive.
11. **Other name-keyed confirms and jobs:** `zfs rollback -r` destroys snapshots newer than the
    challenge listed; `zfs destroy -r` sweeps children created after the challenge; pool
    destroy/export by name after an export/import swap; LUN-held and system-pool checks not
    re-run in the job. **Fix:** bind the guid, re-read in the job, refuse on mismatch; for
    rollback bind the newest snapshot's createtxg; re-run `ownedDescendant` and LUN-held checks.
12. **A dataset path segment named `snapshots` is parsed as a snapshot route**
    (`routes/datasets.ts:378-391`): destroying `tank/snapshots/old` destroys `tank@old`, no
    confirm. `access`/`permissions` segments likewise misroute. **Fix:** address snapshots as
    `<dataset>@<snap>`, or reserve the sub-resource names in `DatasetPath`.
13. **The replication hold tag `anas-repl` is one global tag** (`routes/replication.ts:39`); each
    run releases it on every older snapshot, so two tasks on one source unpin each other's base,
    retention destroys it, the other task fails "diverged". **Fix:** per-task tag; release only
    your own.
14. **PBS prune group `host/<backupId>` defaults to the hostname with no uniqueness check**
    (`backup-prune.ts`, `routes/backup.ts` guardTask); two tasks or a plain client host backup
    share the group and prune each other. **Fix:** refuse duplicate (repo, namespace, backupId);
    default `<host>-<task>`.
15. **A cloud remote PUT can re-point a sync destination with no task check**
    (`routes/cloud.ts:359-431`; DELETE has the check). **Fix:** 409 + confirm naming the tasks,
    including through wrappers.
16. **The source guard knows only fstab mounts and compares paths literally**
    (`source-guard.ts:129`): an unmounted ZFS dataset (key not loaded, canmount=off) backs up as
    an empty "good" snapshot; a symlinked source or a different fs at the target passes. **Fix:**
    realpath; add ZFS `mountpoint,canmount,mounted`; a target counts as mounted only when the
    source matches the spec.
17. **Mount delete `rm -f`s whatever credentials file the fstab line names; the generated name is
    not injective** (`mounts.ts:730`: `/mnt/nas-media` and `/mnt/nas/media` → the same `.cred`).
    **Fix:** remove only a file under credsDir no other line references; hashed name.
18. **Mount mutations `umount` whatever is live at the target path** (`routes/mounts.ts`,
    `isMounted` by target only): a local filesystem at `/mnt/media` after a failed CIFS line gets
    unmounted or mounted over. **Fix:** require live source + fstype to match the spec.
19. **Recycle purge follows a symlinked bin** (`recycle-purge.ts:181`); share users can replace
    `#recycle` with a symlink. **Fix:** `lstat`, refuse symlinks, single-segment repository,
    realpath containment per file.
20. **Recursive chown/chmod/setfacl cross into PVE-owned descendants**
    (`routes/datasets.ts:1220-1538` check only `ownershipOf(fullName)`). **Fix:** refuse when
    `ownedDescendant` is non-null, or stop at filesystem boundaries.

### Wrong-object action (needs a precondition)

21. PVE `dir` storage ownership matched lexically (`matchMountpoint`); a symlinked storage path
    leaves the real dataset unowned. Fix: realpath both sides, fall back to `findmnt -T`.
22. Export leaves `zfs-import@<name>.service` enabled; next boot re-imports a same-named pool.
23. SMB share named `global`/`homes`/`printers` accepted; POST appends a second `[global]` that
    Samba merges; ANAS can neither show nor delete it. Fix: reserve case-insensitively.
24. #68 gap: an orphan passdb entry with the SAME case is inherited after `userdel` at the CLI.
    Fix: any folded entry with `uid===null` is an orphan; refuse or `pdbedit -x` before useradd.
25. User/group delete never checks POSIX ACL grants (contrary to DESIGN.md); uid reuse inherits
    `u:<uid>` grants; `sharesReferencing` ignores `+group`, `write list`, `admin users`,
    `force user/group`. Fix: `getfacl -n` over managed mountpoints → 409.
26. iSCSI `dynamic_sessions` parsed but never counted by the delete/resize/restore gates.
27. Cluster-wide registries (`/etc/pve/anas/remotes.json`, `backup-repos.json`) vs per-node tasks
    and secrets: delete-and-recreate under the same name on node A is followed silently by
    node B with the old secret. Fix: uuid per row, stored in task and secret.
28. AHR destroy does not exclude in-flight `ahr.*` jobs or intents; scrub evidence keyed by pool
    name authorises a parity rewrite on a re-created pool. Fix: 409 while jobs exist; results
    record band md UUIDs.
29. AHR scrub enrollment is a pool-name list in `anas-scrub.service`, unlocked read-modify-write.
30. AHR change-mountpoint edits the first fstab line matching spec; the `@snapshots` line shares
    the spec. Fix: match by mountpoint, exclude `subvol=@snapshots`.
31. AHR rollback renames `@data` away before confirming the snapshot still exists.
32. In-place file restore resolves the destination from the task's current archive without
    checking the snapshot's group/repo belongs to that task; file picks have no confirm.
33. Replication remote / PBS repo PUT can change host or datastore without the retarget confirm.
34. Add-LUN and target-delete use the target snapshot from request time; concurrent adds pick
    the same index.
35. iSCSI stub quarantine on nested non-ZFS mounts fires every read; create accepts the dir.
36. NFS exports keyed by exact path string on the first line; `/etc/exports.d` never read.
37. SMB/NFS share paths on unmounted storage read as present (bare `stat`). Fix: the
    `filesystemOf`/`expectedMount` check iSCSI already uses.

### Wrong data (stale lifecycle, misattribution)

38. Replication picks its base and reports status by snapshot name, never guid (no data loss:
    recv runs without `-F`). Fix: list `name,guid` both sides.
39. Task delete stops only the timer; no DELETE checks for an active run; live props and
    in-memory `findByOperation(name)` lookups are not birth-bounded. Fix: 409 while active; drop
    jobs/timestamps older than the unit's birth.
40. Run-Now verdict takes the newest result/Error line by unit name though the InvocationID is
    read. Fix: `journalctl _SYSTEMD_INVOCATION_ID=<id>`.
41. A stale kernel path for a non-ONLINE leaf joins to the new disk; replace refuses it.
42. Dashboard blames a disabled iSCSI target on the latest failed image restore for that IQN.
43. AHR create-failure overlay matched by pool name can advise destroying a later pool.
44. Mounts inventory attaches an fstab entry to any live node at the same target (no source
    check), suppressing "configured but not mounted".
45. Gateway drops the PVE realm: `alice@pve` and `alice@pam` both become `alice`; uid from
    `id -u` of an unrelated local account; lands in the audit trail. No authorization depends on it.
46. Two same-cadence schedules collide on `anas-<bucket>-<UTC second>` (no RandomizedDelaySec);
    the parent's atomic `-r` fails "dataset already exists" and the pool misses that hour.
47. A retarget edit keeps the unit birth, so history and the cadence gate carry to the new target.

### Cosmetic / low

`readSchedule` does not check the embedded id against the filename; `removeScheduleUnits`
deletes by pattern; POST /schedules TOCTOU; disk-identity-cache fallback keyed on kernel name
(swapped-in disk inherits the SMART verdict); `parsePveStorageCfg` ignores `nodes=`/`disable`
(over-refuses, safe); `associatedShares` misses a trailing slash; `Snapshot.created` from the
human `creation` string (minute precision, local zone) and ordered by it rather than createtxg;
by-id pick depends on `ls` collation; `VdevSpec.disks`/`AddVdevRequest.disks`/`AttachDiskRequest.newDiskId`
are bare strings (`../../sdb` resolves); SMB sections differing only by case; boot sweep of any
`anas-selfheal-*` snapshot; reconcile resets hand-set md knobs; `StatusSummary.node` is the FQDN;
fstab fields not `\040`-escaped; UI selection memory by name/index.

## Verified sound

Jobs (uuid, cancel by id, kill via handle); unit journal verdicts (birth-bounded everywhere);
new-disk paths always by-id with ambiguity refused; pool import by guid; system/root pool block
re-read per request; PVE zfspool ownership from storage.cfg, fail-closed; ZFS periodic scrub as a
pool property; mdadm.conf pins by UUID; AHR scrub/selfheal writes resolved from the pin at point
of use with realpath + findmnt confinement; replication runtime (no `recv -F`, readonly targets,
plan recomputed in the job, pinned host keys, members check); transient run snapshots (anchored
regex, excluded from retention/base); block backup group `lun-<serial>`; PBS delete scope (prune
only, no forget); cloud remote delete guard; config edits (sha256 re-read under lock); #68 passdb
verbs (exact-case + uid, except #24); iSCSI IQN/serial; quarantine/image create; gateway node
identity; telemetry.

## Suggested order of work

1. **Ownership stamping and reserved prefixes** (#1, #13, #46, `anas-` prefix gaps): one shared
   helper setting a ZFS user property at take time; per-task hold tags.
2. **Confirm params carry the stable id; every destructive job re-reads and compares** (#9, #10,
   #11): one helper in `safety/` taking a guid, serial, uid or sorted disk ids.
3. **Wipe and zap verbs act only on devices whose on-disk identity matches** (#2, #3, #4, #5, #7):
   pool guid via blkid, md UUID via `--examine`, VG UUID.
4. **Destroy also clears name-keyed shadow state** (#6, #22, #28, #29).
5. **Mount-presence checks match source as well as target** (#16, #18, #37, #44): the recurring
   "configured-but-unmounted" class.
