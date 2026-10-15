# Live proof — 0.4.4 wave 1b (second node pass of the code-review release), stunt node

Node: the stunt node (PVE 9 / pve-manager 9.2.21, kernel 7.0.14-23-pve, systemd 257.13-1~deb13u1, zfs-2.4.4-pve1,
LVM 2.03.31, mdadm 4.4), ext4 root on `/dev/sda1`, 2026-10-15 UTC.
Build: worktree fast-forwarded to `67e7a9e` (main HEAD; contains cr.19 `902b0d6`, cr.21 `b7be80b`, cr.22 `1f6d61d`,
cr.24 `3b23922`, cr.23 `67e7a9e`).
ADOCK is installed on the same node; none of its pieces were edited or redeployed. `/anas/` and `/adock/` both
answered 401 before and after the pass.

Methods as in [wave 1](LIVE-PROOF-0.4.4-wave1.md): commands run on the node over ssh unless prefixed `host$`; API
calls go through the gateway exactly as the integration specs do
(`https://<node>:8006/anas/api/nodes/anas-pve/v1/...`, root@pam PVEAuthCookie); 202 jobs are polled through
`GET /v1/jobs/:id`; a 409 confirm gate is resent with its `X-Anas-Confirm-Code`.

**Command trace.** For R2, R3 and R6 the exact argv the daemon executed was captured with
`strace -f -qq -e trace=execve -s 300 -p <anasd MainPID>` (strace installed for the pass and purged at the end).
LVM's own metadata archive (`/etc/lvm/archive/*.vg`, `description = "Created *before* executing '…'"`) and
`zpool history` corroborate it. `run()` in `services/ahr-exec.ts` throws on any non-zero exit, so a destroy job that
completes proves every command it ran exited 0.

Classification key (brief rule 4): (a) stale test expectation, (b) test/script bug, (c) product defect, (d) node fact.

---

## R0 — deploy

```
host$ git merge --ff-only main          026bf64..67e7a9e
host$ ./test/stunt-node/deploy-anas.sh
  ✓ anasd active, 0 restarts, /v1/health answers version 0.4.3
  ✓ anas active, /installed answers the same version
anas: proxy hook already present in /usr/share/perl5/PVE/APIServer/AnyEvent.pm (nothing to do)
```

The package version is still 0.4.3, so the sha is proven by content (sha256, first 16 hex):

```
                          host               node (/opt/anas)
services/pool-references.js  f013e77e7b404e68  f013e77e7b404e68
services/system-mounts.js    509b7d40cb658256  509b7d40cb658256
services/ahr-identity.js     eb24b1071ab31952  eb24b1071ab31952
services/mounts.js           aac6c931bcac8e01  aac6c931bcac8e01
routes/pools.js              64a650a349cb5c4e  64a650a349cb5c4e
node# test -e packages/daemon/dist/safety/root-pool.js  -> absent (removed by cr.23)
node# systemctl is-active anasd anas pveproxy adock adockd -> active ×5
host$ curl -sk -o /dev/null -w '%{http_code}' https://<node>:8006/anas/  -> 401   (/adock/ -> 401)
```

**Verdict: PROVEN** — `67e7a9e` deployed; anasd/anas/pveproxy active; `/anas/` answers.

---

## R1 — cr.19: Disable and Remove neutralise automount

Fixture as in wave 1: a throwaway export `/srv/anasproof-nfs` (one `MARKER` file) in
`/etc/exports.d/anasproof.exports` for `127.0.0.1` (`exportfs -ra` still exits 1 over the node's stale
`/testpool/share1` line, a node fact from wave 1; the fixture export is listed regardless).

### Create and arm

```
POST /mounts {"type":"nfs","server":"127.0.0.1","remotePath":"/srv/anasproof-nfs","mountpoint":"/mnt/anasproof-auto","automount":true}
  -> completed {"created":"/mnt/anasproof-auto","warnings":[]}
127.0.0.1:/srv/anasproof-nfs /mnt/anasproof-auto nfs4 vers=4.2,hard,nosuid,nodev,nofail,_netdev,x-systemd.automount 0 0$
   (saved verbatim as the pre-disable line)
POST .../%2Fmnt%2Fanasproof-auto/state {"action":"unmount"} -> completed
# systemctl start 'mnt-anasproof\x2dauto.automount'
mnt-anasproof\x2dauto.automount loaded active waiting
# ls /mnt/anasproof-auto -> MARKER
/mnt/anasproof-auto systemd-1                    autofs
/mnt/anasproof-auto 127.0.0.1:/srv/anasproof-nfs nfs4
mnt-anasproof\x2dauto.automount loaded active running ;  mnt-anasproof\x2dauto.mount loaded active mounted
```

### Disable an armed, accessed automount (API)

```
POST .../%2Fmnt%2Fanasproof-auto/state {"action":"disable"} -> completed {"disabled":"/mnt/anasproof-auto"}   (no warnings)
127.0.0.1:/srv/anasproof-nfs /mnt/anasproof-auto nfs4 vers=4.2,hard,nosuid,nodev,nofail,_netdev,x-anas.disabled-automount,noauto,x-anas.disabled 0 0$
   grep -c x-systemd.automount -> 0
journal (job window):
  systemd[1]: mnt-anasproof\x2dauto.mount: Deactivated successfully.
  systemd[1]: mnt-anasproof\x2dauto.automount: Deactivated successfully.
  systemd[1]: Unset automount mnt-anasproof\x2dauto.automount.
# systemctl list-units --all 'mnt-anasproof*'
  mnt-anasproof\x2dauto.mount loaded inactive dead /mnt/anasproof-auto        <- no .automount unit at all
# findmnt /mnt/anasproof-auto -> nothing;  ls -la /mnt/anasproof-auto -> empty dir;  findmnt after ls -> rc=1 (not mounted)
# ls /run/systemd/generator/remote-fs.target.wants/ | grep anasproof -> rc=1
```

### Exit code of a stop for a unit the generator no longer creates

```
# systemctl daemon-reload
# u=$(systemd-escape --path --suffix=automount /mnt/anasproof-auto)  -> mnt-anasproof\x2dauto.automount
# systemctl show -p LoadState,ActiveState "$u"  -> LoadState=not-found ActiveState=inactive
# systemctl stop "$u"
Failed to stop mnt-anasproof\x2dauto.automount: Unit mnt-anasproof\x2dauto.automount not loaded.
stop-exit=5
```

5 is what `SYSTEMCTL_UNIT_NOT_LOADED` (services/mounts.ts:1197) treats as "no warning". The product took the same
path itself in the Remove of a disabled line below (job result carries no warning).

### Reboot with the line disabled

```
boot_id before 91418cd9-…, after 87d15ac6-…
# grep anasproof /etc/fstab -> …,x-anas.disabled-automount,noauto,x-anas.disabled 0 0
# systemctl list-units --all 'mnt-anasproof*' '*.automount'
  mnt-anasproof\x2dauto.mount loaded inactive dead /mnt/anasproof-auto
  proc-sys-fs-binfmt_misc.automount loaded active running …                 <- the only automount on the node
# ls /run/systemd/generator/remote-fs.target.wants/ -> No such file or directory (nothing wired into boot)
# findmnt /mnt/anasproof-auto -> rc=1;  ls /mnt/anasproof-auto;  findmnt -> rc=1   (access does not mount)
# journalctl -b 0 | grep -iE 'x-anas|anasproof' -> (nothing)
```

(The loop-backed `pvfix`/`sysfix` fixture pools use `cachefile=none` and were re-attached by hand after the reboot,
as in wave 1: `losetup -f --show <img>` + `zpool import -o cachefile=none -d <loop> <pool>`; dataset list identical
to before, `pvesm status` all active.)

### Enable → byte-identical; armed

```
POST .../state {"action":"enable"} -> completed {"enabled":"/mnt/anasproof-auto"}
127.0.0.1:/srv/anasproof-nfs /mnt/anasproof-auto nfs4 vers=4.2,hard,nosuid,nodev,nofail,_netdev,x-systemd.automount 0 0$
# cmp <pre-disable line> <post-enable line>  -> BYTE-IDENTICAL
# systemctl list-units --all 'mnt-anasproof*'
  mnt-anasproof\x2dauto.automount loaded inactive dead      <- generated again
  mnt-anasproof\x2dauto.mount     loaded inactive dead
# ls /run/systemd/generator/remote-fs.target.wants/ -> mnt-anasproof\x2dauto.automount   (boot arming restored)
# systemctl daemon-reload; ls /mnt/anasproof-auto; findmnt -> rc=1
```

Note (d), node fact: `daemon-reload` generates the unit but never starts one, so after Enable the automount is armed
at the next boot (the `remote-fs.target.wants` link is back) and not before. The Enable job does not start it,
and neither does Create (wave 1 and this pass: a created automount line is mounted directly with its `.automount`
`inactive dead`), so this matches how ANAS treats automount lines everywhere. The ruling asks only for the swap
back. Armed by hand the way boot arms it:

```
POST .../state {"action":"mount"} -> completed (mounts directly; .automount stays inactive)   then unmount -> completed
# systemctl start 'mnt-anasproof\x2dauto.automount'; ls /mnt/anasproof-auto -> MARKER
/mnt/anasproof-auto systemd-1 autofs  +  127.0.0.1:/srv/anasproof-nfs nfs4;  .automount active running
```

### Remove an armed, accessed automount

```
DELETE /mounts/%2Fmnt%2Fanasproof-auto?removeMountpointDir=true -> completed {"removed":"/mnt/anasproof-auto"}   (no warnings)
journal: mnt-anasproof\x2dauto.mount: Deactivated successfully. / …automount: Deactivated successfully.
         / Unset automount mnt-anasproof\x2dauto.automount. / Reload requested from client PID … (anasd.service)
# grep -c anasproof /etc/fstab -> 0
# findmnt | grep anasproof -> rc=1                     (no autofs placeholder)
# systemctl list-units --all 'mnt-anasproof*' -> (none); only proc-sys-fs-binfmt_misc.automount listed
# ls -d /mnt/anasproof-auto -> No such file or directory   (the mountpoint dir removal succeeded)
# sha256sum /etc/fstab -> b3c85fb4…23a3 (the pre-pass value)
```

### Variant: armed but never accessed (placeholder only)

```
POST /mounts {… "mountpoint":"/mnt/anasproof-auto2","automount":true} -> completed;  unmount -> completed
# systemctl start 'mnt-anasproof\x2dauto2.automount'
/mnt/anasproof-auto2 systemd-1 autofs ;  …auto2.automount loaded active waiting
POST …auto2/state {"action":"disable"} -> completed {"disabled":"/mnt/anasproof-auto2"}
# findmnt -> rc=1;  units: only …auto2.mount loaded inactive dead;  ls then findmnt -> rc=1
DELETE …auto2?removeMountpointDir=true -> completed {"removed":"/mnt/anasproof-auto2"}   (no warnings: the stop of
   the now-unloaded unit exited 5)
# findmnt | grep anasproof -> nothing; no units; ls -d -> No such file or directory; /etc/fstab b3c85fb4…23a3
```

### Journal

```
# journalctl -b 0 | grep -ci 'x-anas'  -> 0   (no generator, unit or mount complaint about x-anas.disabled-automount)
```

Cleanup: both mounts removed through the API; `/etc/exports.d/anasproof.exports`, ZFS's `zfs.exports.lock` and the
`/etc/exports.d/` directory (absent before the row), `/srv/anasproof-nfs` removed by hand; `/etc/exports` sha256
`f1e3ca20…9743` (pre-pass value).

**Verdict: PROVEN** — wave 1's R1-D1..D3 are fixed on the node: Disable swaps the token and stops the armed unit
(no `.automount` unit, nothing in `remote-fs.target.wants`, access does not mount, also after a reboot); Enable is
byte-identical and restores boot arming; Remove leaves no placeholder, removes the directory, and reports no false
warning; `systemctl stop` of an unloaded automount exits 5; no journal complaint.

---

## R2 — cr.22 / cr.15: the AHR LVM gate with a missing PV, on real LVM

Disks (fresh images, numbers no other fixture uses): `ANAS_HOT16` 1 GiB, `ANAS_HOT17` 2 GiB, `ANAS_HOT18` 2 GiB,
`ANAS_HOT19` 512 MB (cache). Node fact: the layout floors each disk to 1 GiB (`AHR_SIZE_GRANULARITY_BYTES`), so a
512 MB band disk contributes nothing; 1+2+2 GiB gives two bands.

```
POST /ahr/layout/preview {"tier":"ahr1","disks":[HOT16,HOT17,HOT18]}
  -> {"band":1,"memberCount":3,"level":"raid5",…} {"band":2,"memberCount":2,"level":"raid1",…}
POST /ahr {"name":"prv2","tier":"ahr1","disks":[HOT16,HOT17,HOT18]}   (409 confirm, resent)
  -> completed {"created":"prv2","mountpoint":"/mnt/anas-ahr/prv2","arrays":["prv2-r1","prv2-r2"]}
md126 : active raid1 sdf2[1] sde2[0]          md127 : active raid5 sdf1[3] sde1[1] sdd1[0]
/dev/md126 prv2 lvm2 a--  1016.00m   /dev/md127 prv2 lvm2 a--  <1.99g      prv2-vol -wi-ao---- 2.98g
mdadm.conf: ARRAY /dev/md/prv2-r1 … UUID=880041f5:…   ARRAY /dev/md/prv2-r2 … UUID=9bf86638:…
POST /ahr/prv2/cache {"disks":[HOT19]} -> completed (sizeBytes 532676608; warning: rotating cache disk)
/dev/sdg1  prv2  508.00m   (partlabel prv2-cache1);  prv2-vol Cwi-aoC--- cache
# dd 20 MiB of random data into /mnt/anas-ahr/prv2
```

### (a) Shape A — the cache device pulled live; Destroy with an `[unknown]` PV

ANAS's own udev rung (`99-anas-cache.rules` → `anas-cache-event`) would uncache the pool and `vgreduce
--removemissing` on the pull, before Destroy ever saw the missing PV. The rule was parked for this shape
(moved to /root, `udevadm control --reload`) and restored byte-identical afterwards (sha256 `7f6d05dd…419e`).

```
host$ ./test/stunt-node/remove-disk.sh 19            (live virsh detach)
  WARNING: VG prv2 is missing PV G5m7cp-… (last written to /dev/sdg1).
  /dev/md126 prv2 a--   /dev/md127 prv2 a--   [unknown] prv2 a-m        vgs: prv2 #PV 3 wz-pn-
  prv2-vol Cwi-aoC-p-
GET /ahr/prv2 -> state degraded, cache {"state":"failed","deviceMissing":true}
DELETE /ahr/prv2   409 warnings: "Pool 'prv2' (2.98 GiB usable) will be permanently destroyed…",
                   "The filesystem at '/mnt/anas-ahr/prv2' will be unmounted…",
                   "Mount '/mnt/anas-ahr/prv2' is mounted beneath this pool and will stop working"   <- see D3
  resent with the code -> completed {"destroyed":"prv2"}
```

Every mutating command the daemon ran (strace; the 16 `pvs`/`vgs`/`lvs` and 14 `mdadm --detail/--examine` reads
omitted):

```
/usr/bin/umount /mnt/anas-ahr/prv2
/usr/bin/systemctl daemon-reload
/usr/sbin/lvconvert --config devices/allow_mixed_block_sizes=1 -y --uncache prv2/prv2-vol     <- cache device absent
/usr/sbin/lvremove -y prv2/prv2-vol                                                           <- VG still missing a PV
/usr/sbin/vgreduce --config devices/allow_mixed_block_sizes=1 --removemissing prv2            <- plain, no --force, no LVs left
/usr/sbin/vgremove -y prv2
/usr/sbin/pvremove -y /dev/md126            /usr/sbin/pvremove -y /dev/md127                  <- never "[unknown]"
/usr/sbin/mdadm --stop /dev/md126           /usr/sbin/mdadm --stop /dev/md127
/usr/sbin/mdadm --zero-superblock …HOT16-part1, …HOT17-part1, …HOT17-part2, …HOT18-part1, …HOT18-part2
/usr/sbin/sgdisk --zap-all …HOT16, …HOT17, …HOT18
```

LVM's archive agrees (`prv2_00004` "before executing '…lvconvert … --uncache prv2/prv2-vol'", `prv2_00005`
"'…lvremove -y prv2/prv2-vol'", `prv2_00006` "'…vgreduce … --removemissing prv2'"). After: `pvs`/`vgs` empty (no
other VG exists on this ext4-root node; there is no `pve` VG to touch), `/proc/mdstat` no arrays, no `prv2` line in
`mdadm.conf` or `/etc/fstab`, the three disks blank. The pulled cache disk keeps its PV label — destroy cannot scrub a
disk that is not attached; its image was deleted at the end.

### (a) Shape B — a band array gone (the LV itself has a missing segment)

```
POST /ahr {"name":"prvb",…same three disks…} -> completed
# umount /mnt/anas-ahr/prvb; vgchange -an prvb; mdadm --stop /dev/md126   (band 2, raid1)
  /dev/md127 prvb a--   [unknown] prvb a-m      vgs: prvb #PV 2 wz-pn-      prvb-vol -wi-----p-
GET /ahr/prvb -> state offline
DELETE /ahr/prvb  (409 warnings: "…The filesystem at '/dev/prvb/prvb-vol' will be unmounted…", resent)
  -> FAILED: "WARNING: Couldn't find device with uuid U3zpmR-… Failed to find logical volume \"prvb/prvb-vol\""
strace (mutating only): systemctl daemon-reload
                        /usr/sbin/lvremove -y prvb/prvb-vol
                        /usr/sbin/lvremove -y prvb/prvb-vol       <- the SAME LV a second time
after: prvb #PV 2 #LV 0 (the first lvremove succeeded on the partial LV); md127 running; pins still in mdadm.conf
```

`lvremove` of an LV with a segment on the missing PV works on real LVM (the first call removed it); the job died on
the second, identical call. Cause (reproduced on a throwaway loop VG, healthy, two PVs, one LV spanning both):

```
# lvs --noheadings -o lv_name,seg_count,devices anasproofrepro
  v  2 /dev/loop2(0)
  v  2 /dev/loop3(0)
# lvs --reportformat json --units b --nosuffix -o +cache_mode,cache_policy,cache_total_blocks,cache_used_blocks,
      cache_read_hits,cache_read_misses,cache_dirty_blocks anasproofrepro | grep -c '"lv_name":"v"'   -> 2   (LVS_ARGS)
# lvs --reportformat json --units b --nosuffix anasproofrepro | grep -c '"lv_name":"v"'              -> 1
# per column: cache_mode -> 2, cache_policy -> 2, cache_total_blocks -> 1, cache_dirty_blocks -> 1
```

`cache_mode` and `cache_policy` are LVM **segment** fields; with them in `LVS_ARGS` (parsers/lvm-report.ts,
added by ahrcache.1 `a9e0e2f`, 2026-09-24) `lvs` reports one row per segment, and destroy's
`for (const lv of lvs) … lvremove` (services/ahr-destroy.ts) runs once per row. The cached pool in shape A escaped it
only because a cache LV is a single `cache` segment. Confirmed on a HEALTHY uncached two-band pool:

```
POST /ahr {"name":"prvc",…same three disks…} -> completed;  lvs: prvc-vol 2 /dev/md127(0) / prvc-vol 2 /dev/md126(0)
DELETE /ahr/prvc (confirmed) -> FAILED: "Failed to find logical volume \"prvc/prvc-vol\""
after: unmounted, fstab line gone, LV gone; VG prvc (#LV 0) and both arrays still standing
DELETE /ahr/prvc again -> completed {"destroyed":"prvc"}
```

A second Destroy of the half-destroyed `prvb` (VG with no LVs and an `[unknown]` PV) completed and proved the last
owed check:

```
DELETE /ahr/prvb -> completed {"destroyed":"prvb"}
/usr/sbin/vgreduce --config devices/allow_mixed_block_sizes=1 --removemissing prvb      <- plain, no LVs: succeeds
/usr/sbin/vgremove -y prvb
/usr/sbin/pvremove -y /dev/md127;  mdadm --stop /dev/md127;  --zero-superblock on all five member partitions
   (incl. the stopped band's sde2/sdf2);  sgdisk --zap-all ×3
after: no VG, no arrays, no pins, no fstab line, disks blank
```

**Defect R2-D1 (c), pre-existing since ahrcache.1:** AHR Destroy fails on every pool whose volume has more than one
LVM segment — every uncached pool with two or more bands, and any pool an expansion grew — because `LVS_ARGS`
carries the segment fields `cache_mode`/`cache_policy`, so the LV is listed once per segment and `lvremove` is issued
again for an LV the first call already removed. The job fails after the unmount, the fstab removal and the
`lvremove`, leaving the VG and the arrays; a second Destroy finishes. Repro: create an AHR-1 pool on 1+2+2 GiB disks
(two bands), `DELETE /ahr/<name>` → job failed `Failed to find logical volume "<name>/<name>-vol"`. Other readers of
`LVS_ARGS`/`parseLvsReport` (ahr-topology, ahr-cache, ahr-expand-exec) get the same duplicate rows — not checked here.
Not fixed (no row allows it).

### (b) The refusal on real LVM — a foreign VG named like a pool

Shape of the review finding (H6/cr.22): a hand-built md array `pfgn-r1` (RAID1 on two loop devices) pinned the way
`mdadm --detail --scan >> /etc/mdadm/mdadm.conf` pins any array, beside a foreign VG `pfgn` on a third loop device
with its own LV, filesystem and fstab line. `/etc/fstab` and `mdadm.conf` were backed up first.

```
# mdadm --create /dev/md/pfgn-r1 --name=pfgn-r1 --level=1 --raid-devices=2 --metadata=1.2 --run /dev/loop2 /dev/loop3
# mdadm --detail --scan | grep pfgn-r1 >> /etc/mdadm/mdadm.conf
  ARRAY /dev/md/pfgn-r1 metadata=1.2 UUID=8a20525f:f0bb9147:60f744a8:6a6cf83f
# pvcreate /dev/loop4; vgcreate pfgn /dev/loop4; lvcreate -l 100%FREE -n lv0 pfgn; mkfs.ext4 /dev/pfgn/lv0
# echo '/dev/pfgn/lv0 /mnt/anasproof-fgn ext4 defaults,nofail 0 0' >> /etc/fstab; mount /mnt/anasproof-fgn; echo foreign-data > …/MARKER
GET /ahr -> {"name":"pfgn","state":"healthy","mountpoint":"/mnt/anasproof-fgn","mounted":true,"vg":"pfgn"}
```

ANAS lists the stack as a healthy AHR pool (the pin makes the array the pool's; adoption is a display verdict by
design) and takes the foreign LV's mount as the pool's mountpoint.

```
sha256 /etc/fstab before: 2294195143e5…abed   (pre-pass + the foreign line)
DELETE /ahr/pfgn  409 warnings: "Pool 'pfgn' (0.12 GiB usable) will be permanently destroyed…",
   "The filesystem at '/mnt/anasproof-fgn' will be unmounted…", "Mount '/mnt/anasproof-fgn' is mounted beneath this pool…"
  resent with the code -> FAILED:
  "volume group 'pfgn' contains physical volume /dev/loop4 — not this pool's arrays or cache slices. Refusing any
   LVM or md teardown: ANAS only removes a volume group whose every PV is its own"
strace (mutating only):  /usr/bin/umount /mnt/anasproof-fgn
                         /usr/bin/systemctl daemon-reload
   no lvconvert / lvremove / vgreduce / vgremove / pvremove / mdadm --stop / --zero-superblock / sgdisk
after: lv0 pfgn -wi-a----- (LV, VG, PV intact);  md127 raid1 loop3 loop2 running;  the pin still in mdadm.conf
       findmnt /mnt/anasproof-fgn -> rc=1 (UNMOUNTED);  grep pfgn /etc/fstab -> rc=1 (the operator's LINE DELETED)
       sha256 /etc/fstab -> b3c85fb4…23a3
```

Variant — the md array joined to the VG beside the foreign PV (the "hand-added PV" shape):

```
# pvcreate /dev/md/pfgn-r1; vgextend pfgn /dev/md/pfgn-r1      PVs: /dev/loop4 pfgn, /dev/md127 pfgn
DELETE /ahr/pfgn (confirmed) -> FAILED: "volume group 'pfgn' contains physical volume /dev/loop4 — not this pool's…"
strace: 0 umount/lvremove/lvconvert/vgreduce/vgremove/pvremove/sgdisk/wipefs execs, 0 mdadm --stop/--zero-superblock
after: LV, VG (both PVs), array unchanged.  LVM archive for pfgn: only my own lvcreate / vgextend / lvremove (cleanup)
```

**Defect R2-D2 (c):** Destroy runs the unmount and the fstab edit BEFORE the LVM ownership gate
(`destroyAhrPool`: umount → fstab lines removed → `daemon-reload` → `requireOwnedVgPvs`). So for exactly the stack
the gate exists to protect, a refused Destroy still unmounts the foreign filesystem and deletes the operator's own
fstab line for it (found by the pool's mountpoint, which the topology took from the foreign LV's mount). Data and
LVM/md are intact; the mount configuration is not. Repro: hand-build `<vg>-r1` and pin it with `mdadm --detail
--scan >> mdadm.conf`, create VG `<vg>` on another device with an LV mounted from an fstab line, `DELETE /ahr/<vg>`
(confirmed) → job refused, the LV unmounted and its fstab line gone. Not fixed (no row allows it); the gate (or the
identity read it uses) has to run before anything is unmounted or edited.

Cleanup: `lvremove`/`vgremove`/`pvremove` of `pfgn`, `mdadm --stop` + `--zero-superblock` of the loops, three loop
devices detached and their images deleted, `/mnt/anasproof-fgn` removed, `/etc/fstab` and `mdadm.conf` restored from
the backups.

**Verdict: (a) PROVEN** for the LVM behaviour cr.22 owed — on real LVM with a missing PV, `lvconvert --uncache`,
`lvremove`, plain `vgreduce --removemissing` (with and without LVs left) and `vgremove` all succeed, `pvremove` names
only proven PVs and never `[unknown]`, and no foreign VG is touched — **with defect R2-D1 (c)**: any multi-segment
pool volume fails Destroy at a duplicate `lvremove`. **(b) PROVEN** for the refusal (no LVM or md command reaches
the foreign VG or the hand-built array, in both shapes) — **with defect R2-D2 (c)**: the refused Destroy has already
unmounted the foreign filesystem and deleted its fstab line.

---

## R3 — a legacy adopted AHR pool (no pins) destroys end to end

One band (two 2 GiB disks, raid1), so its volume is one segment and R2-D1 does not apply.

```
POST /ahr {"name":"prvl","tier":"ahr1","disks":[HOT17,HOT18]} -> completed {"arrays":["prvl-r1"]}
# echo legacy > /mnt/anas-ahr/prvl/MARKER
mdadm.conf:24: ARRAY /dev/md/prvl-r1 metadata=1.2 UUID=2691151a:bf7b5933:8cf3f8b6:12c887a8
# sed -i '/^ARRAY \/dev\/md\/prvl-r/d' /etc/mdadm/mdadm.conf     -> pins: 0
# systemctl restart anasd    -> active;  pins still 0 (nothing re-pinned it)
GET /ahr -> {"name":"prvl","state":"healthy","mountpoint":"/mnt/anas-ahr/prvl","mounted":true,
             "arrays":[{"device":"/dev/md/prvl-r1","level":"raid1"}]}            <- adopted: unpinned, a PV of its VG
DELETE /ahr/prvl (confirmed) -> completed {"destroyed":"prvl"}
strace (mutating only):
  /usr/bin/umount /mnt/anas-ahr/prvl
  /usr/sbin/lvremove -y prvl/prvl-vol
  /usr/sbin/vgremove -y prvl
  /usr/sbin/pvremove -y /dev/md127
  /usr/sbin/mdadm --stop /dev/md127
  /usr/sbin/mdadm --zero-superblock …HOT17-part1, …HOT18-part1
  /usr/sbin/sgdisk --zap-all …HOT17, …HOT18
after: no VG, no array, no prvl line in /etc/fstab or mdadm.conf, both disks blank
```

**Verdict: PROVEN** — a pre-pin pool is listed after a daemon restart and destroys end to end (cr.15's owed check).

---

## R4 — cr.23: system pools by facts

Node fact: root is ext4 (`findmnt /` → `/dev/sda1 ext4`), no ZFS root, no `pve` VG. `/home` is not empty
(`/home/debian`), so `/srv` (on the list, empty) was used for (b). The standing fixture `sysfix` carries
`bootfs=sysfix/ROOT/pve-1` and serves as the boot-fact control.

### (a) A data pool named `rpool`

```
POST /pools {"name":"rpool","dataVdevs":[{"type":"stripe","disks":[HOT16]}]} -> completed
# zpool get bootfs rpool -> -  ;  mounted only at /rpool
GET /pools -> {"name":"rpool","pve":null}
              {"name":"sysfix","pve":{"kind":"system","reason":"sysfix holds the boot filesystems of pool sysfix",…}}
POST /pools/rpool/export {} -> 409 CONFIRMATION_REQUIRED "Exporting pool 'rpool' has consequences"   X-Anas-Confirm-Code: cbdfff16b
DELETE /pools/rpool        -> 409 CONFIRMATION_REQUIRED "Destroying pool 'rpool' permanently erases all its data"  X-Anas-Confirm-Code: 61c9badbe
control: POST /pools/sysfix/export {} -> 409 CONFLICT reason system-pool
   "Pool 'sysfix' holds this node's boot filesystem (sysfix/ROOT/pve-1) — ANAS never destroys, exports or remounts a system pool"
   (no X-Anas-Confirm-Code header)
```

### (b) One dataset of the same throwaway pool mounted at `/srv`

```
# ls -A /srv | wc -l -> 0;  zfs create -o mountpoint=/srv rpool/srvds;  findmnt /srv -> /srv rpool/srvds zfs
GET /pools -> {"name":"rpool","pve":{"kind":"system","reason":"Pool 'rpool' is mounted at /srv — ANAS never destroys, exports or remounts a system pool",…}}
POST /pools/rpool/export {} -> 409 CONFLICT reason system-pool "Pool 'rpool' is mounted at /srv — …"   (no confirm code)
DELETE /pools/rpool        -> 409 CONFLICT reason system-pool "Pool 'rpool' is mounted at /srv — …"   (no confirm code)
# zpool list rpool -> still there; rpool/srvds mounted
# zfs destroy rpool/srvds;  findmnt /srv -> rc=1;  /srv empty as before
GET /pools -> {"name":"rpool","pve":null}                                    <- back to normal the moment the fact goes
DELETE /pools/rpool (confirmed) -> completed {"destroyed":"rpool"};  /rpool gone
```

**Verdict: PROVEN** — the name `rpool` refuses nothing on an ext4-root node; a dataset at `/srv` makes the same pool
a system pool (stamped and refused, naming the path, no confirm bypass), and the stamp follows the live fact.

---

## R5 — cr.24: export/destroy name what references the pool

Throwaway pool `prref` (HOT17) with datasets `share` and `src`, all through the API; smb.conf and exports backed up.

```
POST /pools {"name":"prref",…HOT17…} -> completed;  POST /pools/prref/datasets {"path":"share"} / {"path":"src"} -> completed
POST /shares/smb {"name":"prrefsmb","path":"/prref/share"} -> completed
POST /shares/nfs {"path":"/prref/share","clients":[{"spec":"127.0.0.1","options":["rw","no_subtree_check"]}]} -> completed
     (wave 1's R3-D1 fixed on the node: the stale /testpool/share1 line no longer rolls this back)
POST /backup/tasks {"name":"prrefbk","repository":"pbsgt","archives":[{"name":"share","path":"/prref/share",…}],
     "schedule":"2030-01-01 00:00:00","enabled":false,…} -> completed
POST /schedules {"id":"prrefsnap","target":{"kind":"zfs","dataset":"prref/src"},"cadence":"hourly","retention":{"hourly":5},"enabled":false} -> completed
POST /replication/tasks {"name":"prrefrep","source":{"pool":"prref","dataset":"src"},"target":{"pool":"prref","dataset":"dst"},
     "schedule":"2030-01-01 00:00:00","enabled":false} -> completed
POST /pools/prref/export {} -> 409 CONFIRMATION_REQUIRED (X-Anas-Confirm-Code present), warnings:
  "SMB share 'prrefsmb' serves '/prref/share', which is a path on this pool, and will stop working"
  "NFS export '/prref/share' serves a path on this pool and will stop working"
  "Backup task 'prrefbk' backs up '/prref/share', which lives on this pool - the source disappears with it"
  "Replication task 'prrefrep' references 'prref/src' on this pool and will break"
  "Replication task 'prrefrep' references 'prref/dst' on this pool and will break"
  "Snapshot schedule 'prrefsnap' takes snapshots of 'prref/src' on this pool"
DELETE /pools/prref -> 409 CONFIRMATION_REQUIRED, the two destroy lines + the same six references
```

(After R6 every reference was removed through the API — replication task, schedule, backup task, NFS export, SMB
share, each confirm-gated — and Export then warned only "Exporting 'prref' makes the pool and all its datasets
unavailable until it is re-imported."; `DELETE /pools/prref` confirmed → destroyed. `/etc/samba/smb.conf`
`46779719…ecea`, `/etc/exports` `f1e3ca20…9743`, `/etc/fstab` `b3c85fb4…23a3`: the pre-pass values; no `prref`
unit or timer stamp left.)

**Defect R2-D3 (c), minor (cr.24):** on an AHR pool the confirm lists the pool's OWN mount as a reference —
"Mount '/mnt/anas-ahr/prv2' is mounted beneath this pool and will stop working" (seen on every AHR Destroy in R2 and
R3) — because `readPoolReferences` adds every fstab entry with `onPoolPath(entry.mountpoint)`, which includes the
pool mountpoint itself, and an AHR pool's own mount is an fstab line. Repro: create any AHR pool, `DELETE
/ahr/<name>` → the 409's warnings carry that line. (Observation, same confirm: an UNMOUNTED pool's line reads "The
filesystem at '/dev/prvb/prvb-vol' will be unmounted" — the LV path stands in for a mountpoint.)

**Verdict: PROVEN** — Export and Destroy name each reference by kind and name (SMB share, NFS export, backup task,
both replication sides, snapshot schedule) and stay a confirm, not a refusal.

---

## R6 — cr.21 spot check: `--` on a replication and a scheduled snapshot; `zpool set` without it

```
POST /schedules/prrefsnap/run {} -> completed {"schedule":"prrefsnap","taken":"anas-hourly-2026-10-15T052252Z","pruned":[],…}
POST /replication/tasks/prrefrep/run {} -> 202 (the unit's run)
journal anas-repl-prrefrep.service:
  {"task":"prref/src","result":{"mode":"full","snapshot":"snapshot-2026-10-15T05-22-54-413Z","bytesEstimated":13424,
   "target":"prref/dst","holdTag":"anas-repl-1bb024237f70"}}   Result=success ExecMainStatus=0
anasd execve (strace):
  /usr/sbin/zfs snapshot -o anas:schedule=prrefsnap -- prref/src@anas-hourly-2026-10-15T052252Z
  /usr/sbin/zfs snapshot -- prref/src@snapshot-2026-10-15T05-22-54-413Z
  /usr/sbin/zfs send -nvP -- prref/src@snapshot-2026-10-15T05-22-54-413Z
  /usr/sbin/zfs send -- prref/src@snapshot-2026-10-15T05-22-54-413Z
  /usr/sbin/zfs recv -o readonly=on -- prref/dst
  /usr/sbin/zfs hold -- anas-repl-1bb024237f70 prref/src@snapshot-…    /usr/sbin/zfs hold -- anas-repl-1bb024237f70 prref/dst@snapshot-…
  /usr/sbin/zfs holds -H -- prref/src@snapshot-… prref/src@anas-hourly-…    /usr/sbin/zfs holds -H -- prref/dst@snapshot-…
zpool history prref (ZFS's own record of the same):
  zpool create -o autoexpand=on -- prref /dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT17
  zfs create -- prref/share ; zfs create -- prref/src
  zfs snapshot -o anas:schedule=prrefsnap -- prref/src@anas-hourly-2026-10-15T052252Z
  zfs snapshot -- prref/src@snapshot-2026-10-15T05-22-54-413Z
  zfs recv -o readonly=on -- prref/dst
  zfs hold -- anas-repl-1bb024237f70 prref/src@snapshot-…  ;  zfs hold -- anas-repl-1bb024237f70 prref/dst@snapshot-…
# zfs list -t all -r prref -> prref/dst@snapshot-…, prref/src@anas-hourly-…, prref/src@snapshot-… present

PUT /pools/prref {"properties":{"comment":"anasproof"}} -> 400 "Property 'comment' is not settable"   (whitelist: autoexpand, autoreplace, autotrim, failmode)
PUT /pools/prref {"properties":{"autotrim":"on"}} -> completed;  zpool get autotrim prref -> on local
strace: execve("/usr/sbin/zpool", ["/usr/sbin/zpool", "set", "autotrim=on", "prref"])          <- no "--"
```

**Verdict: PROVEN** — the local replication (snapshot, dry-run and real send, recv, holds) and the scheduled snapshot
both succeed with `--` before every operand; `zpool set` is issued without it (wave 1 R8: it rejects `--`).

---

## R7 — integration specs touched since wave 1

`testpool` imported by hand for datasets-api (as wave 1 did) and exported again afterwards
(`zfs-import@testpool` stays disabled).

```
host$ npx playwright test tests/integration/alert-encoding.spec.ts --project=integration
  [1/2] … a refused request (400) echoing <b>x</b> shows the literal text
  [2/2] … a failed job whose error carries <b>x</b> shows the literal text
  2 passed (6.0s)                                    /etc/exports sha256 unchanged (f1e3ca20…9743)
host$ npx playwright test tests/integration/datasets-api.spec.ts --project=integration
  5 passed (7.9s)
  (run 2, --reporter=list) ✓ 1 GET /pools/testpool/datasets … ✓ 2 GET /identity/users … ✓ 3 GET /identity/groups …
  ✓ 4 full lifecycle through the API, verified against the real system (2.5s) ✓ 5 plain destroy … recursive … (2.2s)
  5 passed (7.6s)
# zpool export testpool -> zpool import lists testpool ONLINE (found state)
```

**Verdict: PROVEN** — both specs green on the node without changes (datasets-api ×2).

---

## Node state at the end of the pass

| Item | Pre-pass | Post-pass |
|---|---|---|
| `/etc/fstab` sha256 | `b3c85fb4…23a3` | same |
| `/etc/exports` sha256 | `f1e3ca20…9743` (stale `/testpool/share1` line included) | same |
| `/etc/samba/smb.conf` sha256 | `46779719…ecea` | same |
| `/etc/mdadm/mdadm.conf` sha256 | `da56d6ab…aef` | same (AHR create had appended `PROGRAM /usr/local/bin/anas-md-event`, which stays after the last pool is destroyed; the line was removed by hand) |
| `/etc/udev/rules.d/99-anas-cache.rules` | `7f6d05dd…419e` | same (parked for R2 shape A, restored) |
| `AnyEvent.pm` / `index.html.tpl` | `0aad1102…53b0` / `2ee7863c…1c8b` | same (both projects' apt `Post-Invoke` re-apply hooks fired on the strace install and purge; both idempotent) |
| `/etc/exports.d/`, `/etc/lvm/archive`, `/etc/lvm/backup` | absent | absent (created during the pass, removed) |
| `/mnt`, `/srv` | `vzsnap0`; empty | same (`/mnt/anas-ahr/{prv2,prvb,prvc,prvl}` left by the destroys, removed) |
| NFS/CIFS/autofs mounts | binfmt_misc only | same |
| pools | gtbackup, gtiscsi, pvfix (loop0), sysfix (loop1); testpool exported | same; pvfix/sysfix re-attached on loop0/loop1 after the reboot; testpool exported again |
| VGs / md arrays / extra loops | none | none |
| hot disks | HOT1, HOT2 | same (HOT16–19 attached for the pass, detached, images deleted) |
| `/etc/pve/anas`, `/etc/anas/creds` | backup-repos.json, remotes.json; backup-repo-pbsgt.secret | same |
| strace package | not installed | not installed (installed and purged) |
| failed units | `zfs-import@anasactimport`, `zfs-import@anascomp` | same two (pre-existing) |
| `/anas/`, `/adock/` | 401, 401 | 401, 401 |

Left in place: ANAS's own rollback copies `/etc/fstab.bak`, `/etc/exports.bak`, `/etc/samba/smb.conf.bak`,
`/etc/mdadm/mdadm.conf.bak` were rewritten by ANAS's config writer during the pass (whether they existed before
was not recorded); the node was rebooted once (R1).

## Summary

| Row | Verdict | One line |
|---|---|---|
| R0 deploy | PROVEN | `67e7a9e` deployed (dist hashes match), anasd/anas/pveproxy active, `/anas/` 401 |
| R1 cr.19 | PROVEN | disable stops the armed unit and parks the token (no unit, no boot wiring, access and reboot do not mount); enable `cmp`-identical; remove leaves no placeholder, removes the dir, no false warning; stop of an unloaded unit exits 5; journal silent |
| R2 cr.22/cr.15 | (a) PROVEN + FAILED (c) R2-D1; (b) PROVEN + FAILED (c) R2-D2 | missing PV: uncache, lvremove, plain `--removemissing`, vgremove all succeed, pvremove never `[unknown]`; multi-segment LV → duplicate `lvremove` fails Destroy; foreign VG refused with no LVM/md command, but its mount was unmounted and its fstab line deleted first |
| R3 legacy pool | PROVEN | pins removed + anasd restart → still listed; Destroy completes end to end |
| R4 cr.23 | PROVEN | `rpool` on ext4 root gets the normal confirm; a dataset at `/srv` stamps `pve.kind=system` and refuses export/destroy naming `/srv`; `sysfix` refused by its bootfs fact |
| R5 cr.24 | PROVEN (+ minor R2-D3 (c)) | export/destroy 409 name SMB share, NFS export, backup task, replication (both sides), snapshot schedule; AHR confirms list the pool's own mount as a reference |
| R6 cr.21 | PROVEN | snapshot/send/recv/hold/holds carry `--` (strace + `zpool history`); `zpool set autotrim=on prref` has none |
| R7 specs | PROVEN | alert-encoding 2/2, datasets-api 5/5 ×2, no changes |
