# Live proof — 0.4.4 wave 5 (the owed live rows before the fleet), stunt node

Node: the stunt node (PVE 9 / pve-manager 9.2.21, kernel 7.0.14-23-pve, systemd 257.13-1~deb13u1, zfs-2.4.4-pve1,
Node v22.23.3 on the node, v26.12.0 on the host that runs Playwright), 2026-10-17 UTC, 18:56–19:45.
Build: main `2f8a7287a` (cr.67, cr.68, cr.52s-f, cr.69, cr.70 and their review folds), deployed with
`test/stunt-node/deploy-anas.sh`. Run on main, no worktree; nothing was merged into main during the pass.

Methods as in waves 1b–4: API calls go through pveproxy exactly as the panels do
(`https://<node>:8006/anas/api/nodes/<node>/v1/...`, a PVE ticket + CSRF token per user, held in a 0600 curl config
file on the node — never on an argv); a 202 job is polled through `GET /v1/jobs/:id`; a 409 confirm is resent with
`x-anas-confirm: <code>`. Passwords (the throwaway users', root's) were written to 0600 files under `/root` and read
by `curl --data-urlencode password@<file>` / `smbpasswd -s` from stdin; none appears on an argv or below. The argv
witness is `strace -f -qq -s 300 -e trace=<set> -p <anasd MainPID> -o <file>` (stopped after each row).

Throwaway objects carry a `w5` prefix: the `@pve` user `w5audit` and its role `W5SysAuditOnly` (row 1), the cloud task
`w5cancel` (row 1), the samba user `w5smb` (row 3), the AHR pool `w5ahr` (rows 4–5), the NFS export `/srv/w5proof-nfs`
in `/etc/exports.d/w5proof.exports` for `127.0.0.1` (rows 6–8), the mounts `/mnt/w5cifs-*`, `/mnt/w5proof-claim`,
`/mnt/w5proof-legacy`. Every one is removed (§ End state).

Classification key (brief rule): (a) stale expectation, (b) test/script bug, (c) node fact, (d) product defect.

---

## R0 — deploy and wave-4 housekeeping

```
host$ git rev-parse --short HEAD                              -> 2f8a7287a
host$ ./test/stunt-node/deploy-anas.sh
  ✓ anasd active, 0 restarts, /v1/health answers version 0.4.4
  ✓ anas active, /installed answers the same version
host/node sha256 (first 16) of packages/daemon/dist/routes/pools.js: dcc737c32c7ff66a / dcc737c32c7ff66a
node# journalctl -u anasd -b 0 | tail -20     -> start, "anasd listening on /run/anas/anasd.sock", /v1/health 200; no warning
```

Wave 4's leftovers, removed first:

```
node# systemctl disable --now zfs-import@anasactimport.service
Removed '/etc/systemd/system/zfs-import.target.wants/zfs-import@anasactimport.service'.
node# systemctl reset-failed; systemctl --failed --no-legend | wc -l      -> 0
node# rm -rf /root/np        (strace traces of wave 4 rows 1–6, strace.pid, trace.sh, zfsget.txt; strace not running)
```

root@pam's notification email left as found.

---

## R1 — cr.67: an Audit-only user through pveproxy — PASS

```
node# pveum role add W5SysAuditOnly --privs Sys.Audit
POST /api2/json/access/users  userid=w5audit@pve  password@<0600 file>     -> HTTP 200
node# pveum acl modify / --users w5audit@pve --roles W5SysAuditOnly
node# pveum user permissions w5audit@pve --path /      -> /  Sys.Audit (*)
```

As `w5audit@pve`:

```
GET  /v1/mounts                                                         -> HTTP 200
POST /v1/cloud/tasks/preview  {"source":"/gtbackup/cloudsrc","remote":"gtcancelsftp"}
   -> HTTP 202 {"job":{"operation":"read.cloud.preview","createdBy":"w5audit@pve",...}}    (completed)
POST /v1/cloud/remotes/test   {"name":"gtcancelsftp"}
   -> HTTP 202 {"job":{"operation":"read.cloud.remote.test",...}}  completed, verdict "auth"
POST /v1/backup/restore/browse {"repo":"pbsgt","snapshot":"host/w5probe/2026-10-17T00:00:00Z","archive":"root.pxar","path":"/"}
   -> HTTP 202 {"job":{"operation":"read.backup.catalog",...}}     completed, verdict "not-found"
POST /v1/backup/restore/browse (same body) then at once POST /v1/jobs/<that id>/cancel
   -> HTTP 202 {"job":{"operation":"job.cancel","createdBy":"w5audit@pve"}}
   the browse job: "status":"cancelled", "reason":"cancelled by w5audit@pve at 2026-10-17T18:57:51.645Z"
POST /v1/cloud/tasks/preview/  (trailing slash)                         -> HTTP 403
PUT  /v1/cloud/tasks/preview                                            -> HTTP 403
PUT  /v1/cloud/remotes/test                                             -> HTTP 403
POST /v1/mounts {"type":"nfs",...,"mountpoint":"/mnt/w5-never"}         -> HTTP 403
   each: {"error":{"code":"FORBIDDEN","message":"Permission check failed (/, Sys.Modify): w5audit@pve does not
          have it. ANAS asks the privilege PVE asks for its own disk and ZFS operations."}}
```

The gateway's `[authz]` journal lines for the refusals (nothing is logged for a pass):

```
[authz] forbidden: w5audit@pve POST /api/nodes/<node>/v1/cloud/tasks/preview/ lacks Sys.Modify on /
[authz] forbidden: w5audit@pve PUT /api/nodes/<node>/v1/cloud/tasks/preview lacks Sys.Modify on /
[authz] forbidden: w5audit@pve PUT /api/nodes/<node>/v1/cloud/remotes/test lacks Sys.Modify on /
[authz] forbidden: w5audit@pve POST /api/nodes/<node>/v1/mounts lacks Sys.Modify on /
```

### The cancel of a job that is not a read job

The brief's shape (a scrub started as root, cancelled by the Audit-only user) answered **409, not 403**:

```
root:  POST /v1/pools/gtbackup/scrub {}              -> 202 zpool.scrub (completed in 0 s: "scrub repaired 0B in 00:00:00")
audit: POST /v1/jobs/<scrub id>/cancel               -> HTTP 409 {"error":{"code":"NOT_CANCELLABLE","message":"Job '…'
       (zpool.scrub) cannot be cancelled — it registers no way to stop its work; wait for it to finish"}}
```

Classification **(a) stale expectation in the brief**: a scrub job registers no cancel hook, and
`routes/jobs.ts:137–150` refuses a not-running / not-cancellable target with its sentence BEFORE it asks the
authority question (:152–153) — the documented order (the comment at :109–111: no code is minted for a cancel that
cannot happen). What the 409 tells an Audit-only user (the job's operation and that it cannot be cancelled) is what
its own `GET /v1/jobs/:id` already shows. The row was re-run with a RUNNING, cancellable mutation job:

```
host$ ./test/stunt-node/cloud-review-fixture.sh up cancel          (loopback sftp user + gtbackup/gtcancelsrc)
root:  POST /v1/cloud/tasks {"name":"w5cancel","source":"/gtbackup/gtcancelsrc","remote":"gtcancelsftp",
       "path":"w5cancel-dst","mode":"copy","excludes":[],"bwlimit":"100k","notify":"on-failure",
       "schedule":"2030-01-01 00:00:00","enabled":true}                                -> 202, completed
root:  POST /v1/cloud/tasks/w5cancel/run {}                    -> 202 cloud.task.run; the row's runningJobId = c3f59914-…
audit: POST /v1/jobs/c3f59914-…/cancel                         -> HTTP 403 FORBIDDEN "Permission check failed (/, Sys.Modify): w5audit@pve …"
```

The 403 is the DAEMON's (the gateway passed the cancel path as cr.67 says):

```
anasd: {"reqId":"req-1o","req":{"method":"POST","url":"/v1/jobs/c3f59914-…/cancel"},"msg":"incoming request"}
anasd: {"event":"job.refused","user":"w5audit@pve","operation":"job.cancel","privilege":"Sys.Modify",
        "msg":"audit: w5audit@pve refused job.cancel: lacks Sys.Modify on / (holds Sys.Audit on /)"}
anasd: {"reqId":"req-1o","res":{"statusCode":403}}
```

The run was then cancelled as root (409 confirm → replay → 202 `job.cancel`; the run job `cancelled`), the task
removed (`DELETE /v1/cloud/tasks/w5cancel` → 202 completed; `GET /v1/cloud/tasks` → `[]`), and
`cloud-review-fixture.sh down cancel` (gtcancelsrc destroyed, rclonegt removed, the rclone store untouched).
`pveum user delete w5audit@pve`, `pveum role delete W5SysAuditOnly`; user list → `['root@pam']`.

One malformed probe in the record, for completeness: a cancel sent with an EMPTY id (`/jobs//cancel`, a script slip
before the task existed) got the gateway's 403 (`[authz] forbidden: … POST …/v1/jobs//cancel lacks Sys.Modify`) — the
malformed-cancel near-miss cr.67 pins.

**Verdict: PASS** — the three read doors and a read-job cancel pass for Sys.Audit; the near-misses and a plain mutation
answer the gateway's 403 naming Sys.Modify; a cancel of a running mutation job reaches the daemon and answers its 403
naming Sys.Modify.

---

## R2 — cr.68: the four re-pinned specs, each run twice — 3 of 4 PASS; ahr-cache-ui FAIL (b) + (d)

Fixture set: the node as wave 4 left it (setup-test-data, gtpools, pvepool, four 256 M spares hot3–hot6, the hand-made
`datapool` zfspool storage), plus `ahrcache-fixture.sh up` (hot7/hot8/hot9). Each spec with
`npx playwright test tests/integration/<spec> --project=integration`.

```
attempt 1 (19:00–19:08 UTC)
  ahr-cache-api run 1     4 passed (2.7m)
  ahr-cache-api run 2     1 failed / 3 passed — :717 boot-rung precondition (below); anasd + anas left STOPPED
  ahr-cache-ui runs 1, 2  3 failed each — every test: /v1/disks had no `data` (the daemon was down)    -> void
  cloud-remotes-ui run 1  killed mid-run when the stopped daemon was found                            -> void
attempt 2 (19:14–19:29 UTC; the runner checks `systemctl is-active anasd anas` after every run)
  ahr-cache-api run 3     4 passed (2.8m)        daemon after: active active
  ahr-cache-api run 4     4 passed (2.6m)        daemon after: active active
  ahr-cache-ui run 1      2 failed / 1 passed    daemon after: active active
  ahr-cache-ui run 2      2 failed / 1 passed    daemon after: active active
  cloud-remotes-ui run 1  7 passed (45.7s)
  cloud-remotes-ui run 2  7 passed (46.6s)
  replication-ui run 1    7 passed (45.5s)
  replication-ui run 2    7 passed (40.6s)
```

- **ahr-cache-api** — the re-pin at :292 (either SOURCE spelling) PASSES in 3 of 3 runs that reached it, with the daemon
  mounting by `/dev/<vg>/<lv>`. The one failure is elsewhere: **(b) spec/fixture race**, :717 of the boot-rung test —
  `pull-cache` hot-detaches the cache disk and the spec runs `vgchange -ay gtcache` at once
  (`ahrcache-fixture.sh` says "No settle to wait for"), and in run 2 the guest still saw the PV:
  `Expected pattern: /partial|Refusing/i  Received string: "1 logical volume(s) in volume group \"gtcache\" now active"`.
  1 of 4 runs. Its consequence is worse than the test: the test had already run `systemctl stop anasd` (:711) and
  only `restart-daemon` (:720) brings it back, with no `finally`, so a failure in that window leaves the node with
  anasd AND the gateway (`PartOf`) stopped and voids every spec run after it — exactly what happened here. Repro: run
  the spec until :717 fails; `systemctl is-active anasd anas` → inactive inactive. Fix (not a one-liner, not made):
  wait in `pull-cache` until the by-id link is gone, and restart the daemon in a `finally` around :711–:720.
- **ahr-cache-ui** — the re-pin at :247/:349 (scroll the card AND the bay into view before the drag) does NOT land the
  drag, 2 of 2 runs, both drag tests:
  ```
  :285  Expected substring: "a rotating cache adds a seek, not speed"
        Received: "Attach read cache: gtcache… Available …ANAS_HOT5 …HOT4 …HOT3 …HOT6 …HOT9 … Cache bay Drag disks here …"
  :388  Expected substring: "Attach cache failed"   Received: "Attach cache Drag at least one disk into the cache bay."
  ```
  The Remount test (no drag) passes. Cause, from the screenshots and the source: the cache disk is the FIFTH card in the
  Available tray (the fixture set's four 256 M spares come first), and the tray and the bay live in ONE scrollable body
  of a 620×480 window (`39-ahr.js` ~:2256–:2266, `scrollable: true`). With HOT9 scrolled into view the bay is scrolled
  off the top of that body (screenshot after the card-only variant below: cards HOT4…HOT9 fill the body, the bay is not
  visible); scrolling the bay into view afterwards scrolls HOT9 back below the fold (screenshot after the committed
  helper: the tray at the top, HOT5/HOT4/HOT3 visible, the bay empty). The drag hit-tests drop zones with
  `document.elementFromPoint` and has no auto-scroll (`15-gfx.js` :1798, :1848), so no pointer path reaches a bay that
  is clipped. A probe that dropped `await bay.scrollIntoViewIfNeeded()` (card only) failed the same two tests (3.3 min
  run) and was reverted — so no one-line fix exists in the helper.
  Classification: **(b)** the re-pin cannot pass on this fixture set; and **(d) LOW, UI** — an operator with five or
  more available disks cannot drag a disk below the fold into the bay without first enlarging the window (the window
  IS resizable — `x-window-resizable` — which is the workaround). Levers, for a story: give the tray its own scroller
  (a max-height on `[data-anas-zone="tray"]`) so the bay stays in view, or auto-scroll the body during a drag; on the
  spec side, enlarge the window before the drag or drag with the spares absent.
- **cloud-remotes-ui** — PASS 2/2; test 7 (the reload after the save-refusal alert is dismissed) passes in both. The
  daemon's four `EISDIR` 500s in the journal (PUT/GET `/v1/cloud/remotes…`, 19:26:23 and 19:27:10) are test 7's own
  injection (`mv rclone.conf rclone.conf.failing && mkdir rclone.conf`, :453), not a defect.
- **replication-ui** — PASS 2/2; :377's `ensureClusterKey` found no key in run 1 and created it
  (`job.submitted replication.keypair.create` … `completed (18ms)`, the only keypair POST of the pass); run 2 found it.
  The key stays on the node (no DELETE route) — listed under End state.

**Verdict:** cr.68 (a), (c), (d) PROVEN live; (b) NOT — the helper re-pin cannot reach the bay on this fixture set
(classified above, with a UI finding behind it).

---

## R3 — cr.52s-f F3: a failed CIFS create removes only the leaf it made — PASS

Server: the node's own smbd, share `share1` (`/testpool/share1`). User `w5smb` (unix user, `smbpasswd -s -a` from a
0600 file). Preflight first, so the failure below is the password and nothing else:

```
POST /v1/mounts/test {cifs, 127.0.0.1, share1, w5smb + the right password}  -> {"verdict":"ok","stage":"mount",…}
POST /v1/mounts/test {…, a wrong password}  -> {"verdict":"auth-failed","detail":"Authentication failed — check the
     username or password (CIFS cannot tell the two apart).","stage":"mount",…}
```

### Leaf absent

```
node# ls -d /mnt/w5cifs-new        -> No such file or directory;  /etc/fstab sha256 b3c85fb4…;  /etc/anas/creds: backup-repo-pbsgt.secret
strace -e trace=execve,mkdirat,mkdir,unlinkat,rmdir
POST /v1/mounts {"type":"cifs","server":"127.0.0.1","remotePath":"share1","mountpoint":"/mnt/w5cifs-new",
                 "credentials":{"username":"w5smb","password":<wrong>}}            -> 202 mount.create
job: failed — "Mount create '/mnt/w5cifs-new' failed — mount error(13): Permission denied
     Refer to the mount.cifs(8) manual page (e.g. man mount.cifs) and kernel log messages (dmesg); the credentials file
     was removed; '/mnt/w5cifs-new' was created by this job and has been removed again. Nothing else was written
     (no /etc/fstab line)"
trace:
  423650 mkdir("/proc/self/fd/23/w5cifs-new", 0777) = 0
  498428 execve("/usr/bin/mount", ["/usr/bin/mount", "-c", "-t", "cifs", "-o", "vers=3.1.1,credentials=/etc/anas/creds/mnt-23207aa0630a.cred,nosuid,nodev", "--", "//127.0.0.1/share1", "/proc/self/fd/3/."], …) = 0
  498429 execve("/sbin/mount.cifs", ["/sbin/mount.cifs", "//127.0.0.1/share1", "/proc/self/fd/3/.", "-o", "rw,vers=3.1.1,credentials=…,nosuid,nodev"], …) = 0
  423652 rmdir("/proc/self/fd/23/w5cifs-new") = 0
after: ls -d /mnt/w5cifs-new -> No such file or directory; grep -c w5cifs /etc/fstab -> 0; /etc/fstab b3c85fb4…;
       /etc/anas/creds: backup-repo-pbsgt.secret only; findmnt rc=1
```

(The credentials file's removal is node's `unlink(2)`, not in this trace set; the listing proves it. The second case
adds `unlink` to the set.)

### Leaf exists, empty, made before the job

```
node# mkdir /mnt/w5cifs-exist; stat -c '%i %y'  -> 666907 2026-10-17 19:29:52.327099193 +0000
strace -e trace=execve,mkdirat,mkdir,unlinkat,unlink,rmdir
POST /v1/mounts {… "mountpoint":"/mnt/w5cifs-exist", wrong password}   -> 202
job: failed — "Mount create '/mnt/w5cifs-exist' failed — mount error(13): Permission denied
     Refer to … (dmesg); the credentials file was removed. Nothing else was written (no /etc/fstab line)"
trace:
  423650 mkdir("/proc/self/fd/23/w5cifs-exist", 0777) = -1 EEXIST (File exists)
  498548 execve("/usr/bin/mount", [… "//127.0.0.1/share1", "/proc/self/fd/3/."], …) = 0
  423650 unlink("/etc/anas/creds/mnt-950f36f79991.cred") = 0
  (no rmdir)
after: stat -> 666907 2026-10-17 19:29:52.327099193 +0000 (same inode, same mtime), empty; fstab line 0; creds as before
```

**Verdict: PASS** — the job removes the leaf it created, through the parent fd, and leaves a directory that existed
before it; no fstab line, no credentials file, the sentence exact in both cases. Cleanup: `/mnt/w5cifs-exist` removed,
`smbpasswd -x w5smb`, `userdel w5smb`.

---

## R4 — cr.52s-f F6: the AHR doors gate a missing parent and mkdir through the parent fd — PASS

Disks: hot7 + hot8 (1 GiB each, the ahrcache fixture's band disks, blank).

```
POST /v1/ahr {"name":"w5ahr","tier":"ahr1","disks":[…HOT7,…HOT8],"mountpoint":"/mnt/w5-noparent/pool"}
  -> HTTP 409 {"error":{"code":"CONFLICT","message":"Mountpoint '/mnt/w5-noparent/pool' cannot be used — its parent
     '/mnt/w5-noparent' does not exist. ANAS creates the mountpoint only inside an existing parent; it never creates
     a chain of directories a user could re-point"}}
  (before any confirm; ls -d /mnt/w5-noparent -> No such file; hot7 still has no partitions)
```

A create whose parent exists, under strace (`execve,mkdirat,mkdir,rmdir`):

```
POST /v1/ahr {… "mountpoint":"/mnt/w5ahr"} -> 409 CONFIRMATION_REQUIRED (2 disks WIPED) -> replay -> 202 ahr.create
job: completed {"created":"w5ahr","mountpoint":"/mnt/w5ahr","arrays":["w5ahr-r1"]}
trace (the daemon's lines; the update-initramfs children's relative mkdirs filtered out):
  423649 mkdir("/proc/self/fd/23/w5ahr", 0777) = 0
  503859 execve("/usr/bin/mount", ["/usr/bin/mount", "-c", "-t", "btrfs", "-o", "subvolid=5", "--", "/dev/w5ahr/w5ahr-vol", "/proc/self/fd/3/."], …) = 0
  503930 execve("/usr/bin/mount", ["/usr/bin/mount", "-c", "-t", "btrfs", "-o", "subvol=@data", "--", "/dev/w5ahr/w5ahr-vol", "/proc/self/fd/3/."], …) = 0
findmnt: /dev/w5ahr/w5ahr-vol[/@data] /mnt/w5ahr btrfs
fstab:   /dev/w5ahr/w5ahr-vol /mnt/w5ahr btrfs nofail,subvol=@data,x-systemd.before=rtslib-fb-targetctl.service,x-systemd.device-timeout=45s 0 0
```

The mountpoint-move door on the existing pool:

```
PUT /v1/ahr/w5ahr/mountpoint {"mountpoint":"/mnt/w5-noparent/x"}
  -> HTTP 409 {"error":{"code":"CONFLICT","message":"Mountpoint '/mnt/w5-noparent/x' cannot be used — its parent
     '/mnt/w5-noparent' does not exist. ANAS creates the mountpoint only inside an existing parent; …"}}
findmnt /mnt/w5ahr -> /dev/w5ahr/w5ahr-vol[/@data] /mnt/w5ahr   (still mounted); /mnt/w5-noparent absent; fstab line unchanged
```

Note (c): the create job writes its own `ARRAY /dev/md/w5ahr-r1` line into `/etc/mdadm/mdadm.conf` (product behaviour;
the file was never edited by hand in this pass) and the destroy removes it (`grep -c w5ahr /etc/mdadm/mdadm.conf` → 0
after R5).

**Verdict: PASS.**

---

## R5 — cr.52s-f F7: the forced-read-only Remount door refuses a pool whose own line says `ro` — PASS

```
node# cp /etc/fstab <backup>; sed -i '…/s/ nofail,/ ro,nofail,/' /etc/fstab
diff: < /dev/w5ahr/w5ahr-vol /mnt/w5ahr btrfs nofail,subvol=@data,…
      > /dev/w5ahr/w5ahr-vol /mnt/w5ahr btrfs ro,nofail,subvol=@data,…
node# systemctl daemon-reload; umount /mnt/w5ahr && mount /mnt/w5ahr
findmnt -no OPTIONS /mnt/w5ahr -> ro,relatime,discard=async,space_cache=v2,subvolid…
POST /v1/ahr/w5ahr/remount {}
  -> HTTP 409 {"error":{"code":"CONFLICT","message":"AHR pool 'w5ahr' is mounted read-only by its own line in
     '/etc/fstab' — the line's options carry 'ro', so this read-only is the configuration, not a btrfs fault. Remount
     would unmount every open handle and re-run that same line, landing read-only again; nothing was unmounted.
     Remove 'ro' from that line if the pool should be writable"}}
findmnt -> still mounted, ro (no confirm code minted, nothing unmounted)
```

The `ro` removed (the backup copied back, `cmp` → identical), and the pool made read-only by the KERNEL with a line
that does not say `ro`:

```
node# mount -o remount,ro /mnt/w5ahr; grep w5ahr /etc/fstab | grep -c ' ro,' -> 0
POST /v1/ahr/w5ahr/remount {} -> 409 CONFIRMATION_REQUIRED "Remounting pool 'w5ahr' unmounts and mounts its filesystem"
   -> replay -> 202 ahr.remount -> completed {"mountpoint":"/mnt/w5ahr","readOnly":false}
findmnt -> /dev/w5ahr/w5ahr-vol[/@data] /mnt/w5ahr rw,relatime,…;  touch + rm of a probe file -> writable
```

Cleanup: `DELETE /v1/ahr/w5ahr` (confirm) → completed `{"destroyed":"w5ahr"}`; fstab and mdadm.conf carry no `w5ahr`;
the empty `/mnt/w5ahr` left by the destroy (documented, services/ahr-destroy.ts:50) removed by hand; then
`ahrcache-fixture.sh down && up` so hot7–hot9 are blank again.

**Verdict: PASS.**

---

## R6 — the `/` live-claim guard (`parsePveMountPaths`) — PASS on what can be staged safely; the `live === '/'` branch not reached live

```
before: zfs get -H -o property,value,source mountpoint,canmount datapool
  mountpoint /datapool local
  canmount   on        default
  (no children; empty)
node# zfs set canmount=off datapool && zfs set mountpoint=/ datapool
staged: mountpoint / local; canmount off local; mounted no;  findmnt -S datapool -> rc=1;  findmnt / -> /dev/sda1 ext4
NFS export /srv/w5proof-nfs for 127.0.0.1 (/etc/exports.d/w5proof.exports; /etc/exports.d absent before)
POST /v1/mounts {"type":"nfs","server":"127.0.0.1","remotePath":"/srv/w5proof-nfs","mountpoint":"/mnt/w5proof-claim"}
  -> 202 -> completed {"created":"/mnt/w5proof-claim","warnings":[]}      (not refused as inside 'datapool')
  fstab: 127.0.0.1:/srv/w5proof-nfs /mnt/w5proof-claim nfs4 vers=4.2,hard,nosuid,nodev,nofail,_netdev 0 0
GET /v1/mounts, the pve fields per row:
  /                    {'pveManaged': False}
  /mnt/w5proof-claim   {'pveManaged': False}
  /pvfix               {'pveManaged': True, 'pveStorage': 'pvfix'}
  /pvfix/dump          {'pveManaged': True, 'pveStorage': 'pvfixdump'}
  /sysfix/data         {'pveManaged': True, 'pveStorage': 'sysfix-data'}
```

What this does and does not prove: the guard's live claims come from the MOUNT TABLE (`readPveTerritoryClaims` →
`zfsLiveDatasetMounts(findmnt)`), and with `canmount=off` the dataset is not in the table at all, so the
`live !== '/'` skip (pve-storage.ts :577–:579) is not exercised by this staging; the storage stanza's own
`mountpoint /datapool` is the only config claim. Reaching the branch needs a dataset really MOUNTED on `/`, which
over-mounts the node's root filesystem — judged unsafe on this node and not done. As the closest live evidence, the
deployed module was run on the node against the node's real storage.cfg:

```
node# node --input-type=module -e '…import { parsePveMountPaths } from "/opt/anas/packages/daemon/dist/parsers/pve-storage.js"…'
claims with live datapool=/ : [["/var/lib/vz","local"],["/pvfix","pvfix"],["/pvfix/dump","pvfixdump"],["/sysfix/data","sysfix-data"],["/datapool","datapool"]]
control, live datapool=/srv/elsewhere claimed: datapool
```

Restore:

```
node# zfs set mountpoint=/datapool datapool
node# zfs inherit canmount datapool  -> 'canmount' property cannot be inherited
node# zfs set canmount=on datapool; zfs mount datapool
after: mountpoint /datapool local; canmount on LOCAL; mounted yes; findmnt -> datapool /datapool; pvesm status: datapool active
```

Node fact (c): `canmount` is not inheritable, so its SOURCE cannot go back to `default`; the value is restored (`on`),
the source now reads `local`.

**Verdict: PASS** (no refusal of a path under `/`, no storage claim on `/`); the branch itself is proven by the unit
suite and by the deployed module above, not by a live mount on `/`.

---

## R7 — cr.6 (c): PVE tooling is indifferent to `x-anas.disabled` — PASS

On R6's mount (datapool restored first):

```
pre:  127.0.0.1:/srv/w5proof-nfs /mnt/w5proof-claim nfs4 vers=4.2,hard,nosuid,nodev,nofail,_netdev 0 0$
POST /v1/mounts/%2Fmnt%2Fw5proof-claim/state {"action":"disable"} -> 202 -> completed {"disabled":"/mnt/w5proof-claim"}
line: 127.0.0.1:/srv/w5proof-nfs /mnt/w5proof-claim nfs4 vers=4.2,hard,nosuid,nodev,nofail,_netdev,noauto,x-anas.disabled 0 0$
findmnt /mnt/w5proof-claim -> rc=1
pvesm status            -> rc=0, all five storages active, 0 lines on stderr
pvesm list local        -> rc=0 (header only), 0 lines on stderr
pvesm list pvfixdump    -> rc=0 (header only)
systemctl daemon-reload -> 0 lines of output
journalctl -b 0 | grep -ci x-anas -> 0
POST …/state {"action":"enable"} -> completed {"enabled":"/mnt/w5proof-claim"}
cmp <pre line> <post line> -> BYTE-IDENTICAL
```

**Verdict: PASS** — cr.6 (c) proven; the three cr.6 node items are now all live-proven.

---

## R8 — cr.70 (a): the legacy `comment=systemd.automount` spelling is parked on Disable — PASS

```
node# cp /etc/fstab <backup>; mkdir /mnt/w5proof-legacy
node# printf '%s\n' '127.0.0.1:/srv/w5proof-nfs /mnt/w5proof-legacy nfs4 vers=4.2,hard,nosuid,nodev,nofail,_netdev,comment=systemd.automount 0 0' >> /etc/fstab
node# systemctl daemon-reload
systemctl list-units --all '*.automount':
  mnt-w5proof\x2dlegacy.automount   loaded inactive dead      <- the generator honours the legacy spelling
ls /run/systemd/generator/remote-fs.target.wants/ -> … mnt-w5proof\x2dlegacy.automount
node# systemctl start 'mnt-w5proof\x2dlegacy.automount'; ls /mnt/w5proof-legacy -> MARKER
findmnt: /mnt/w5proof-legacy systemd-1 autofs  +  /mnt/w5proof-legacy 127.0.0.1:/srv/w5proof-nfs nfs4
```

Disable (strace `execve`):

```
POST /v1/mounts/%2Fmnt%2Fw5proof-legacy/state {"action":"disable"} -> 202 -> completed {"disabled":"/mnt/w5proof-legacy"}  (no warnings)
argv: /usr/bin/umount /mnt/w5proof-legacy
      /usr/bin/systemctl stop mnt-w5proof\x2dlegacy.automount
      /usr/bin/systemctl daemon-reload
line: 127.0.0.1:/srv/w5proof-nfs /mnt/w5proof-legacy nfs4 vers=4.2,hard,nosuid,nodev,nofail,_netdev,x-anas.disabled-automount=comment,noauto,x-anas.disabled 0 0$
units: mnt-w5proof\x2dlegacy.mount loaded inactive dead (no .automount unit);  .automount LoadState=not-found ActiveState=inactive
remote-fs.target.wants: no legacy link
access: findmnt rc=1; ls (0 entries); findmnt after ls rc=1 — access does not mount
```

Enable:

```
POST …/state {"action":"enable"} -> completed {"enabled":"/mnt/w5proof-legacy"}
line: …,_netdev,comment=systemd.automount 0 0$
cmp <hand-written line> <post-enable line> -> BYTE-IDENTICAL to the hand-written line
units: mnt-w5proof\x2dlegacy.automount loaded inactive dead (generated again); remote-fs.target.wants has the link again
systemctl start …automount; ls -> MARKER; autofs + nfs4 mounted; ActiveState=active
```

Remove (armed and accessed):

```
DELETE /v1/mounts/%2Fmnt%2Fw5proof-legacy?removeMountpointDir=true -> 409 confirm -> replay -> completed {"removed":"/mnt/w5proof-legacy"}
DELETE /v1/mounts/%2Fmnt%2Fw5proof-claim?removeMountpointDir=true  -> 409 confirm -> replay -> completed {"removed":"/mnt/w5proof-claim"}
grep -c w5proof /etc/fstab -> 0;  findmnt | grep -c w5proof -> 0 (no placeholder);  units '*w5proof*' -> 0;
ls -d /mnt/w5proof-* -> No such file;  /run/systemd/generator/remote-fs.target.wants/ -> absent;
/etc/fstab sha256 b3c85fb4… (the pre-pass value)
```

**Verdict: PASS.** Export removed afterwards (`/etc/exports.d/w5proof.exports`, ZFS's `zfs.exports.lock`, the
`/etc/exports.d/` directory, `/srv/w5proof-nfs`; `exportfs -ra` rc 0; `/etc/exports` sha256 `f1e3ca20…` as before).

---

## R9 — cr.69 (b): a Disable with `result.warnings` in the panel — not exercised live

No warnings-bearing job occurred live: every Disable/Enable in R7 and R8 completed with
`{"disabled":…}` / `{"enabled":…}` and no `warnings` (the legacy Disable's `systemctl stop` of an armed unit exited 0).
The harness rows cr.69 added cover the alert path; nothing was browser-checked for it.

---

## End state

- Removed: `w5audit@pve` + role `W5SysAuditOnly`; samba/unix user `w5smb`; cloud task `w5cancel` and the cancel fixture
  profile (`down cancel`); AHR pool `w5ahr` (+ its empty mountpoint dir); all `w5` fstab lines (fstab sha256 back to
  `b3c85fb4…`), mountpoints, units and the NFS export (`/etc/exports` `f1e3ca20…`, `/etc/exports.d/` absent as before);
  `/root/w5` (the pass's scripts, 0600 password/ticket files and strace traces); strace not running.
- `datapool`: `mountpoint=/datapool` (local), `canmount=on` (source now `local`, was `default` — not inheritable), mounted.
- Fixture set as found plus the ahrcache disks: hot7/hot8/hot9 attached and blank (`ahrcache-fixture.sh up`), pools
  datapool, gtbackup, gtiscsi, pvfix, sysfix, testpool; anasd + anas active; `systemctl --failed` empty.
- Left on purpose: the cluster replication keypair created by replication-ui run 1 (`ensureClusterKey`; the API offers
  no DELETE); wave 4's `zfs-import@anasactimport` unit is now disabled and reset (its template unit file is the
  package's); strace stays installed (as wave 4 left it); root@pam's email as found; the pre-existing cloud remote
  `gtcancelsftp` (present before the pass) untouched. `/testpool/share1` was `chmod 755` (it already read `drwxr-xr-x`).

## Summary

| Row | Story | Verdict |
|-----|-------|---------|
| R0 | deploy + wave-4 housekeeping | done |
| R1 | cr.67 Audit-only doors | PASS (the scrub-cancel expectation was stale: 409 NOT_CANCELLABLE by design; a running cloud run's cancel → daemon 403 Sys.Modify) |
| R2 | cr.68 four specs ×2 | ahr-cache-api, cloud-remotes-ui, replication-ui PASS; ahr-cache-ui 2 drag tests FAIL 2/2 (b, + a LOW UI finding); one ahr-cache-api boot-rung race (b) that stops the daemon |
| R3 | cr.52s-f F3 | PASS |
| R4 | cr.52s-f F6 | PASS |
| R5 | cr.52s-f F7 | PASS |
| R6 | `/` live-claim guard | PASS as staged; the `live === '/'` branch not reachable without mounting a dataset on `/` (unsafe; skipped), deployed module checked on the node |
| R7 | cr.6 (c) | PASS |
| R8 | cr.70 (a) | PASS |
| R9 | cr.69 (b) | no warnings-bearing job live; harness covers it |
