# Live proof — 0.4.4 wave 1 (code-review release), stunt node

Node: the stunt node (PVE 9, systemd 257.13-1~deb13u1, libpve-http-server-perl 6.0.5), 2026-10-15 UTC.
Build: worktree at `d525a3a` (main HEAD; contains every cr.* commit of wave 1).
ADOCK is installed on the same node (AdockProxy hook block in AnyEvent.pm, `adock`/`adockd` active); none of
its pieces were touched. `/anas/` and `/adock/` both answered 401 (up) before the pass.

Commands below run on the node over ssh unless prefixed `host$`. API calls go through the gateway exactly as the
integration specs do: `https://<node>:8006/anas/api/nodes/anas-pve/v1/...` with a root@pam PVEAuthCookie;
202 jobs are polled through `GET /v1/jobs/:id`.

Classification key (brief rule 4): (a) stale test expectation, (b) test/script bug, (c) product defect, (d) node fact.

---

## R0 — deploy

```
host$ ./test/stunt-node/deploy-anas.sh
  ✓ anasd active, 0 restarts, /v1/health answers version 0.4.3
  ✓ anas active, /installed answers the same version
anas: removed stale /usr/share/perl5/PVE/APIServer/AnyEvent.pm.anas-orig from an older install (...)
anas: proxy hook already present in /usr/share/perl5/PVE/APIServer/AnyEvent.pm (nothing to do)
```

The package version is still 0.4.3 (no bump yet), so the sha is proven by content:

```
host$ sha256sum packages/daemon/dist/routes/mounts.js packages/shared/dist/formats/fstab.js
b130a9b0…370d  packages/daemon/dist/routes/mounts.js
8d3601ec…dc59  packages/shared/dist/formats/fstab.js
node# (same two hashes under /opt/anas)
node# grep -rl x-anas.disabled /opt/anas/packages/daemon/dist/routes/mounts.js   -> present
node# systemctl is-active anasd anas pveproxy   -> active active active
host$ curl -sk -o /dev/null -w '%{http_code}' https://<node>:8006/anas/   -> 401
```

**Verdict: PROVEN** — `d525a3a` deployed; anasd/anas/pveproxy active; `/anas/` answers.

---

## R1 — cr.6: disable writes `noauto,x-anas.disabled`

Fixture: a throwaway NFS export `/srv/anasproof-nfs` (one `MARKER` file) in `/etc/exports.d/anasproof.exports`
for `127.0.0.1`; removed at the end of the row.

### Create (API)

```
POST /mounts {"type":"nfs","server":"127.0.0.1","remotePath":"/srv/anasproof-nfs","mountpoint":"/mnt/anasproof-plain","automount":false}  -> 202, completed
POST /mounts {... "mountpoint":"/mnt/anasproof-auto","automount":true}                                                                -> 202, completed

127.0.0.1:/srv/anasproof-nfs /mnt/anasproof-plain nfs4 vers=4.2,hard,nosuid,nodev,nofail,_netdev 0 0
127.0.0.1:/srv/anasproof-nfs /mnt/anasproof-auto nfs4 vers=4.2,hard,nosuid,nodev,nofail,_netdev,x-systemd.automount 0 0
```

(saved verbatim as `anasproof-fstab-before.txt` for the byte comparison below)

### Disable both (API), automount NOT armed at the time

```
POST /mounts/%2Fmnt%2Fanasproof-plain/state {"action":"disable"}  -> completed {"disabled":"/mnt/anasproof-plain"}
POST /mounts/%2Fmnt%2Fanasproof-auto/state  {"action":"disable"}  -> completed {"disabled":"/mnt/anasproof-auto"}

127.0.0.1:/srv/anasproof-nfs /mnt/anasproof-plain nfs4 vers=4.2,hard,nosuid,nodev,nofail,_netdev,noauto,x-anas.disabled 0 0
127.0.0.1:/srv/anasproof-nfs /mnt/anasproof-auto nfs4 vers=4.2,hard,nosuid,nodev,nofail,_netdev,x-systemd.automount,noauto,x-anas.disabled 0 0

# systemctl daemon-reload; systemctl list-units --all '*.mount' '*.automount' | grep anasproof
mnt-anasproof\x2dauto.automount   loaded inactive dead  mnt-anasproof\x2dauto.automount
mnt-anasproof\x2dauto.mount       loaded inactive dead  /mnt/anasproof-auto
mnt-anasproof\x2dplain.mount      loaded inactive dead  /mnt/anasproof-plain
# mount -a; echo rc=$?           -> rc=0, nothing mounted at either path
# findmnt --fstab                -> both lines listed, options include noauto,x-anas.disabled
GET /mounts -> {"mountpoint":"/mnt/anasproof-auto","state":"disabled","mounted":false,"automount":true,"disabled":true}
               {"mountpoint":"/mnt/anasproof-plain","state":"disabled","mounted":false,"automount":false,"disabled":true}
```

On reload the automount is generated but not started. **But the generator still wires it into boot:**

```
# ls -la /run/systemd/generator/remote-fs.target.wants/ | grep anasproof
mnt-anasproof\x2dauto.automount -> ../mnt-anasproof\x2dauto.automount
# systemctl show -p WantedBy 'mnt-anasproof\x2dauto.automount'
WantedBy=remote-fs.target
```

systemd-fstab-generator applies `noauto` to the `.mount` unit only; an `x-systemd.automount` line still gets
its `.automount` added to `remote-fs.target.wants` (this is the documented `noauto,x-systemd.automount`
"lazy mount" idiom). The reboot below confirms it.

### Disable WHILE the automount is armed

```
POST .../anasproof-auto/state {"action":"enable"} -> completed
# systemctl start 'mnt-anasproof\x2dauto.automount'
mnt-anasproof\x2dauto.automount loaded active waiting
/mnt/anasproof-auto autofs systemd-1                          <- armed placeholder
POST .../anasproof-auto/state {"action":"disable"} -> completed {"disabled":"/mnt/anasproof-auto"}
# fstab line: ...,x-systemd.automount,noauto,x-anas.disabled 0 0
mnt-anasproof\x2dauto.automount loaded active waiting         <- STILL ARMED after the daemon's daemon-reload
/mnt/anasproof-auto autofs systemd-1
# ls /mnt/anasproof-auto
MARKER                                                        <- first access MOUNTS the disabled share
/mnt/anasproof-auto nfs4 127.0.0.1:/srv/anasproof-nfs
mnt-anasproof\x2dauto.mount loaded active mounted
GET /mounts -> {"mountpoint":"/mnt/anasproof-auto","state":"disabled","mounted":true,"automount":true,"disabled":true}
```

### Reboot with both lines disabled

```
boot_id before 29e9ec8f-…, after 91418cd9-…
# grep anasproof /etc/fstab   -> both lines still carry noauto,x-anas.disabled
# systemctl list-units --all 'mnt-anasproof*'
mnt-anasproof\x2dauto.automount loaded active   waiting       <- ARMED AT BOOT
mnt-anasproof\x2dauto.mount     loaded inactive dead
mnt-anasproof\x2dplain.mount    loaded inactive dead          <- plain line correctly stays down
/mnt/anasproof-auto autofs systemd-1
# journalctl -b: "systemd[1]: Set up automount mnt-anasproof\x2dauto.automount."
# ls /mnt/anasproof-auto  -> MARKER
journal: "Got automount request for /mnt/anasproof-auto, triggered by 1552 (ls)" … "Mounted mnt-anasproof\x2dauto.mount"
```

The plain line behaves as the ruling says. The automount line does not: a disabled `x-systemd.automount` line
is armed at every boot and mounts on first access.

### Enable both → byte-identical, and they mount

```
POST .../anasproof-plain/state {"action":"enable"} -> completed
POST .../anasproof-auto/state  {"action":"enable"} -> completed
# diff anasproof-fstab-before.txt anasproof-fstab-after.txt && cmp ...   -> BYTE-IDENTICAL (diff empty), cmp-same
POST .../anasproof-plain/state {"action":"mount"}  -> completed; /mnt/anasproof-plain nfs4 127.0.0.1:/srv/anasproof-nfs
POST .../anasproof-auto/state  {"action":"unmount"} -> completed; placeholder autofs left (expected for an enabled automount)
# ls /mnt/anasproof-auto -> MARKER; /mnt/anasproof-auto nfs4 127.0.0.1:/srv/anasproof-nfs
```

### Legacy `#ANAS` line

```
# echo '#ANAS 127.0.0.1:/srv/anasproof-nfs /mnt/anasproof-legacy nfs4 vers=4.2,hard,nosuid,nodev,nofail,_netdev 0 0' >> /etc/fstab
GET /mounts -> {"mountpoint":"/mnt/anasproof-legacy","state":"disabled","mounted":false,"disabled":true,"persistent":true}
POST .../anasproof-legacy/state {"action":"enable"} -> completed
127.0.0.1:/srv/anasproof-nfs /mnt/anasproof-legacy nfs4 vers=4.2,hard,nosuid,nodev,nofail,_netdev 0 0   <- active line restored
POST .../anasproof-legacy/state {"action":"mount"} -> completed; /mnt/anasproof-legacy nfs4 127.0.0.1:/srv/anasproof-nfs
```

### PVE tooling

```
# pvesm status          -> local, pvfix, pvfixdump, sysfix-data all "active", no warnings
host$ curl https://<node>:8006/   -> 200 (PVE UI loads)
# journalctl -b 0 | grep -ci x-anas  -> 0   (no unit, generator or mount complaint about the option)
```

### Teardown — and a second automount finding

```
DELETE /mounts/%2Fmnt%2Fanasproof-plain?removeMountpointDir=true   -> completed
DELETE /mounts/%2Fmnt%2Fanasproof-auto?removeMountpointDir=true    -> completed, warning:
   "'/mnt/anasproof-auto' is still in use — the directory was left in place."
DELETE /mounts/%2Fmnt%2Fanasproof-legacy?removeMountpointDir=true  -> completed
# findmnt | grep anasproof
/mnt/anasproof-auto systemd-1 autofs ...                       <- orphaned placeholder
mnt-anasproof\x2dauto.automount not-found active waiting
# ls /mnt/anasproof-auto  -> "Host is down"
journal: "Suppressing automount event since unit is no longer loaded." / "Failed with result 'resources'."
```

Removed by hand: `systemctl stop` + `reset-failed` the orphaned automount, `rmdir /mnt/anasproof-auto`,
`/etc/exports.d/anasproof.exports`, `/srv/anasproof-nfs`, and `/etc/exports.d/` itself (it did not exist before
the row; ZFS dropped a `zfs.exports.lock` in it at boot). `/etc/fstab` sha256 back to `b3c85fb4…23a3`
(the pre-pass value).

### Verdict: **FAILED (c)** for automount lines; PROVEN for plain lines

- Plain line: disable → `noauto,x-anas.disabled`, inactive after reload and after reboot, `mount -a` skips it,
  `findmnt --fstab` lists it, enable is byte-identical, legacy `#ANAS` read as disabled and enabled correctly,
  PVE unbothered. **PROVEN.**
- **Defect R1-D1 (c):** a disabled `x-systemd.automount` line is still armed at every boot
  (`remote-fs.target.wants/…automount`) and mounts the share on first access. The §2 Mounts ruling's premise
  ("a hand edit that removes it leaves `noauto`, so the mount still does not come up at boot") holds only for
  lines without `x-systemd.automount`. Repro: create an NFS mount with `automount:true`, Disable it, reboot,
  `ls <mountpoint>` → mounted.
- **Defect R1-D2 (c):** Disable of an ARMED automount leaves the live placeholder armed (the daemon only
  daemon-reloads; the `.automount` unit is never stopped); first access mounts the disabled share. Repro: arm,
  Disable, `ls <mountpoint>`.
- **Defect R1-D3 (c):** Remove (DELETE) of an armed automount line leaves an orphaned autofs placeholder whose
  unit is `not-found active waiting`; the mountpoint directory is left "in use" and any access fails
  "Host is down" until `systemctl stop <unit>.automount`. Same root cause as D2.
- Not fixed (no row allows it). The fix needs a design call: the disable form for an automount line must
  also neutralise `x-systemd.automount` (e.g. drop it and record it in the marker so enable restores it
  byte-identically), and disable/remove must `systemctl stop <escaped>.automount` before the daemon-reload.

---

## R2 — cr.2: fstab escaping on a real node (CIFS, spaces)

ANAS refuses a space in an SMB share name (`ShareName` = `^[\w-]+$`), so the share was made by hand:
`[anas proof]` (path `/srv/anasproof-smb`, guest ok; the node's `map to guest = Bad User` maps the throwaway
credential to guest, so no Samba user was created). smb.conf was backed up first and restored after.

```
POST /mounts {"type":"cifs","server":"127.0.0.1","remotePath":"anas proof","mountpoint":"/mnt/anas proof",
              "credentials":{"username":"proofguest","password":"x"}}            -> 202, completed

# grep anas /etc/fstab | cat -A
//127.0.0.1/anas\040proof /mnt/anas\040proof cifs vers=3.1.1,credentials=/etc/anas/creds/mnt-723ffab8d017.cred,nosuid,nodev,nofail,_netdev 0 0$
# findmnt -n -o TARGET,SOURCE -t cifs
/mnt/anas proof //127.0.0.1/anas proof
# cat "/mnt/anas proof/MARKER"        -> smbmarker
# findmnt --fstab -n -o TARGET,SOURCE -t cifs
/mnt/anas proof //127.0.0.1/anas proof
# systemctl list-units -t mount | grep proof
mnt-anas\x20proof.mount loaded active mounted /mnt/anas proof
GET /mounts -> {"mountpoint":"/mnt/anas proof","source":"//127.0.0.1/anas proof","server":"127.0.0.1",
                "remotePath":"anas proof","state":"ok","mounted":true,"persistent":true,...}
```

Cycle through the API and by hand (each resolves the line from fstab by its escaped mountpoint):

```
POST …/%2Fmnt%2Fanas%20proof/state unmount -> completed
# mount "/mnt/anas proof"   (fstab lookup by hand)  -> mounted //127.0.0.1/anas proof; umount
POST … mount   -> completed; /mnt/anas proof //127.0.0.1/anas proof
POST … disable -> //127.0.0.1/anas\040proof /mnt/anas\040proof cifs …,_netdev,noauto,x-anas.disabled 0 0
POST … enable  -> //127.0.0.1/anas\040proof /mnt/anas\040proof cifs …,_netdev 0 0
DELETE …?removeMountpointDir=true -> completed; creds file removed; /mnt/anas proof gone
```

**Defect R2-D1 (c):** `GET /mounts/%2Fmnt%2Fanas%20proof` returns `entry`, `configuredOptions`, `unit` and
`credentials` correctly but **no `fstabLine`** for this persisted mount, so the Mounts detail panel
(`67-mounts.js` reads `d.fstabLine`) shows no fstab line. Cause: `fstabLineFor()` in
`packages/daemon/src/services/mounts.ts` compares the RAW second field (`/mnt/anas\040proof`) with the decoded
mountpoint (`/mnt/anas proof`); it needs `unescapeFstabField(fields[1]) === mountpoint`. Every mountpoint with
an escaped character (space, tab, `\`, a leading `#`) is affected. Repro: create any mount whose mountpoint has a
space; `GET /mounts/<enc>` → `fstabLine` absent. (Separately, by design or not: the same helper skips lines
starting with `#`, so a legacy `#ANAS` line also has no `fstabLine`.) Not fixed: R2 allows no product fix.

Cleanup: mount removed through the API; `/etc/samba/smb.conf` restored from the backup and reloaded
(sha256 `46779719…ecea`, the pre-pass value); `/srv/anasproof-smb` removed; `/etc/fstab` back to `b3c85fb4…23a3`.

**Verdict: PROVEN** (the fstab line carries `\040`, `mount` works, `findmnt` reports the real path, the mounts list
shows it correctly) — with defect R2-D1 (c) in the detail endpoint.

---

## R3 — cr.13: /etc/exports rollback on a rejected reload

### Node fact first: this node's `exportfs -ra` already fails

The node's `/etc/exports` carries one pre-existing line whose path is gone (`testpool` is not imported):

```
/testpool/share1 192.168.200.0/24(rw,sync,no_subtree_check,no_root_squash)
# exportfs -ra; echo rc=$?
exportfs: Failed to stat /testpool/share1: No such file or directory
rc=1                               <- the other lines are still exported; only the rc says "failed"
```

Control: a perfectly valid export through the API on the node as found:

```
sha256 /etc/exports before: f1e3ca20…9743
POST /shares/nfs {"path":"/srv/anasproof-exp","clients":[{"spec":"127.0.0.1","options":["rw","no_subtree_check"]}]}
-> job failed: "exportfs: Failed to stat /testpool/share1: No such file or directory"
sha256 /etc/exports after:  f1e3ca20…9743 (rolled back); exportfs -v shows no anasproof line
```

**Defect R3-D1 (c), a regression from cr.13:** one stale line in `/etc/exports` — exactly the state the
Shares list itself flags as `pathExists:false` after a dataset or pool goes away — makes `exportfs -ra` exit 1,
and since cr.13 every ANAS export create/update/remove of ANY OTHER path is now rolled back and fails with the
stale path's message. Before cr.13 the job also failed but the (valid) change stayed applied. `exportfs -ra`'s
exit status mixes "this file is unparseable" with "some path could not be stat'ed"; the rollback should key on
the former (or on whether the line ANAS wrote is in `exportfs -v` afterwards), not on rc alone. Repro: leave any
export whose path does not exist in `/etc/exports`, then create any valid export through ANAS → job fails,
file rolled back. Not fixed (R3 allows no product fix).

For the rest of the row the stale line was removed temporarily (file backed up byte-for-byte and restored at
the end); with it gone `exportfs -ra` → rc=0.

### The bracketed IPv6 spec is accepted (node fact)

```
POST /shares/nfs {"path":"/srv/anasproof-exp","clients":[{"spec":"[fe80::1]","options":["rw","no_subtree_check"]}]}  -> completed
/srv/anasproof-exp [fe80::1](rw,no_subtree_check)
exportfs -v:  [fe80::1](sync,wdelay,hide,no_subtree_check,sec=sys,rw,secure,root_squash,no_all_squash)
(removed again: DELETE -> 409 + X-Anas-Confirm-Code, resent with x-anas-confirm -> completed)
```

Other validator-passing specs probed by hand (`exportfs -ra` rc after appending `/srv/anasproof-exp <spec>(rw)`):

| spec | rc | exportfs says |
|---|---|---|
| `[fe80::1]`, `@nosuchnetgroup`, `*.*`, `1.2.3.4/255.0.255.0`, `[::1`, `gss/bogus` | 0 | accepted, listed |
| `999.1.1.1`, `nosuchhost.invalid`, `fe80::1%eth0`, `a:b:c` | 0 | "Failed to resolve …", not listed |
| `1.2.3.4/99` | 1 | ``Invalid prefix `99' for 1.2.3.4/99`` |
| `/x` | 1 | `Invalid IP address /x` |
| `-x` | 1 | `/etc/exports:1: unknown keyword "x(rw)"` |

Observation (not filed as a defect): a spec with a leading `-` passes `isExportClientSpec` and exportfs parses it
as an exports(5) default-options block (`-x` → `unknown keyword "x(rw)"`). With option tokens already free-form
this grants nothing new, but the validator could refuse a leading `-`.

### Rejected create — file byte-identical, kernel matches

```
sha256 before: 3f95c811…2fee3     (no export lines; exportfs -ra rc=0)
POST /shares/nfs {"path":"/srv/anasproof-exp","clients":[{"spec":"1.2.3.4/99","options":["rw","no_subtree_check"]}]}
-> job failed: "exportfs: Invalid prefix `99' for 1.2.3.4/99 …"
# sha256sum -c   -> /etc/exports: OK
# exportfs -v    -> (empty)   matches the file (no non-comment lines)
```

### Rejected update over a LIVE export — file byte-identical, kernel keeps the old client

```
POST /shares/nfs {… "spec":"127.0.0.1" …} -> completed
/srv/anasproof-exp 127.0.0.1(rw,no_subtree_check)          sha256 84c3c7d5…e428
PUT /shares/nfs/%2Fsrv%2Fanasproof-exp {"clients":[{"spec":"127.0.0.1",…},{"spec":"1.2.3.4/99","options":["ro"]}]}
-> job failed: "exportfs: Invalid prefix `99' …"
# sha256sum -c   -> /etc/exports: OK
/srv/anasproof-exp 127.0.0.1(rw,no_subtree_check)
exportfs -v:  /srv/anasproof-exp  127.0.0.1(sync,wdelay,hide,no_subtree_check,sec=sys,rw,secure,root_squash,no_all_squash)
```

Cleanup: export removed through the API (confirm-gated DELETE); `/etc/exports` restored from the backup
(sha256 `f1e3ca20…9743`, the pre-pass value, stale line included) and re-exported; `/srv/anasproof-exp` removed.

**Verdict: PROVEN** (rejected change → job fails, file byte-identical, `exportfs -v` matches the file), using
`1.2.3.4/99` since the node accepts `[fe80::1]` — **with defect R3-D1 (c)**: on a node carrying any stale export
line (this one as found), every ANAS export mutation is rolled back.

---

## R4 — cr.14: the atomic-write helper on pmxcfs

A node script (node v22.23.3) imported the DEPLOYED helper
(`/opt/anas/packages/daemon/dist/services/config-writer.js` → `writeFileAtomic`) and then repeated each fs call
the helper makes, raw, so the errors the helper swallows on pmxcfs are visible. Random suffix `d6267ba8`.

```
== /etc/pve/anas/probe-d6267ba8.json
  writeFileAtomic create (mode 0o600 asked): OK mode=640 uid=0 gid=33 size=8
  read back: OK "{\"n\":1}\n"
  writeFileAtomic replace: OK mode=640 uid=0 gid=33 size=8
  read back: OK "{\"n\":2}\n"
  leftover temp files: OK []
  raw open(tmp, "wx", 0o600): OK
  raw fh.writeFile: OK
  raw fh.sync (file fsync): OK
  raw fh.datasync: OK
  raw fh.chmod(0o640): OK
  raw fh.chown(0,33): OK
  raw fh.close: OK
  raw open(tmp, "wx") again (O_EXCL on existing): THROWS EEXIST
  raw rename(tmp, raw): OK
  raw stat(raw): OK mode=640 uid=0 gid=33 size=10
  raw read(raw): OK "{\"raw\":1}\n"
  raw stat(tmp) after rename: THROWS ENOENT
  raw open(dir, "r"): OK
  raw dir fsync: OK
  cleanup: probe files left: OK []
== /etc/pve/priv/anas/probe-d6267ba8.json
  writeFileAtomic create: OK mode=600 uid=0 gid=33 size=8
  writeFileAtomic replace: OK mode=600 uid=0 gid=33 size=8      (read back "{\"n\":1}\n" then "{\"n\":2}\n")
  leftover temp files: OK []
  raw open(tmp, "wx", 0o600): OK
  raw fh.sync (file fsync): OK          raw fh.datasync: OK
  raw fh.chmod(0o640): THROWS EPERM     <- pmxcfs refuses a chmod under priv/
  raw fh.chown(0,33): OK
  raw open(tmp, "wx") again: THROWS EEXIST
  raw rename(tmp, raw): OK; stat(raw) mode=600 uid=0 gid=33; stat(tmp) ENOENT
  raw dir fsync: OK
  cleanup: probe files left: OK []
```

Node facts recorded: on this pmxcfs (PVE 9) O_EXCL create works (a second `wx` open gets EEXIST); file fsync,
fdatasync and directory fsync all SUCCEED (the helper's `.catch` on pmxcfs is defensive, not exercised here);
rename is atomic and immediately visible; the mode is pmxcfs's, not the caller's (`0640` under `/etc/pve/anas`
although `0600` was asked, `0600` under `/etc/pve/priv/anas`), owner `root:www-data`. A chmod under `priv/` is
refused with EPERM — the helper's "no chmod/chown on pmxcfs" branch is what keeps the priv writers working.
Both probe files and both raw files removed; directory listings identical to before.

Real writer through the API (the replication-remotes registry, written by `writeFileAtomic`; no external system):

```
/etc/pve/anas/remotes.json before: version 17, remotes [], 640 root:www-data 96 B
POST /replication/remotes {"expectedVersion":17,"remote":{"name":"anasproof","host":"127.0.0.1","port":22,"user":"root"}}
-> completed {"created":"anasproof","version":18}
# cat remotes.json -> "version": 18, "remotes": [{"name":"anasproof","host":"127.0.0.1","port":22,"user":"root"}]
   640 root:www-data 215 B; no temp file left in /etc/pve/anas
GET /replication/remotes -> version 18, the anasproof remote listed
DELETE /replication/remotes/anasproof?expectedVersion=18 -> completed {"removed":"anasproof","version":19}
# cat remotes.json -> "version": 19, "remotes": []
```

Left behind by design: `remotes.json` is now version 19 (monotonic CAS counter) and pretty-printed; content
(no remotes) as before.

**Verdict: PROVEN.**

---

## R5 — cr.7: uninstall/reinstall on the REAL AnyEvent.pm (ADOCK installed)

```
# dpkg -S /usr/share/perl5/PVE/APIServer/AnyEvent.pm   -> libpve-http-server-perl
# dpkg-query -W libpve-http-server-perl                -> 6.0.5
# dpkg --verify libpve-http-server-perl                -> ??5??????   /usr/share/perl5/PVE/APIServer/AnyEvent.pm
# grep AnyEvent.pm /var/lib/dpkg/info/libpve-http-server-perl.md5sums -> d638eb737348e4099534b5d04e84825a
# md5sum live                                          -> da8905ff… (two hook blocks spliced)
# apt-get download libpve-http-server-perl=6.0.5; dpkg-deb -x … x
# md5sum x/…/AnyEvent.pm                               -> d638eb737348e4099534b5d04e84825a  (= dpkg's record: the package's own bytes)
```

Before (ADOCK block then ANAS block, both after package line 1228):

```
# diff <package> <live>
1228a1229,1248
> 	# >>> ADOCK proxy hook (additive; restored on uninstall/upgrade-clobber)
> …10 lines…
> 	# <<< ADOCK proxy hook
> 	# >>> ANAS proxy hook (additive; restored on uninstall/upgrade-clobber)
> …10 lines…
> 	# <<< ANAS proxy hook
ADOCK block saved: 10 lines, sha256 db7ac4bb…c770
```

Uninstall:

```
# /opt/anas/packages/pve-integration/uninstall.sh
anas: removed script line from /usr/share/pve-manager/index.html.tpl
anas: removed /usr/share/pve-manager/js/anas.js
anas: removed apt hook /etc/apt/apt.conf.d/80anas-pve-integration
anas: excised the ANAS hook block from …/AnyEvent.pm (another project's hook is present and was preserved)
anas: pveproxy restarted (proxy hook removed)
anas: removed /usr/share/anas/perl/AnasProxy.pm
rc=0
# diff <package> <live>          -> 1228a1229,1238  (exactly the ADOCK block, nothing else)
# ADOCK block re-extracted | cmp <saved>                     -> byte-identical
# sed '/ADOCK hook/,/ADOCK end/d' <live> | cmp - <package>   -> equal: the module is the package's bytes + ADOCK's block
# grep -c 'ANAS proxy hook' <live> -> 0;  no AnyEvent.pm.anas-orig (deploy had already removed the stale one)
# index.html.tpl: only the adock.js script line remains; js dir: adock.js only
# systemctl is-active pveproxy -> active
host$ /  -> 200   /adock/ -> 401   /anas/ -> 500 "no such file '/anas/'" (PVE's own answer for an unknown path)
```

Reinstall:

```
# /opt/anas/packages/pve-integration/install.sh
anas: another project's proxy hook is present — splicing ADDITIVELY alongside it
anas: spliced ANAS proxy hook into …/AnyEvent.pm
anas: pveproxy restarted (proxy hook live)
rc=0
# ADOCK block | cmp <saved>   -> byte-identical
# live minus both blocks | cmp - <package> -> equal
# systemctl is-active pveproxy anasd anas adock adockd -> all active
host$ /anas/ -> 401   /adock/ -> 401
```

Side effect to know: both installers splice after the same anchor (package line 1228), so the most recent
installer's block goes first. After the reinstall the ANAS block now sits ABOVE the ADOCK block (and the
`anas.js` script line above `adock.js` in index.html.tpl), so AnyEvent.pm's sha256 changed
(`f901b8cd…4974` → `0aad1102…53b0`) and index.html.tpl's too, with ADOCK's block and line byte-identical.
The two hooks match disjoint path prefixes, so the order has no effect. Temp files (`/root/anasproof-pkg`,
the saved block) removed.

**Verdict: PROVEN.**

---

## R8 — cr.12 prerequisite: does every zpool/zfs subcommand accept `--` on this node's ZFS? (coordinator addition)

Read-only. A script first aborts if any of `nosuch`, `nosuchp`, `nosuch/ds`, `/dev/nonexist`, `/dev/sdz` exists,
then runs each command with stdin closed and prints rc + the first output line.

```
## zpool version
zfs-2.4.4-pve1
zfs-kmod-2.4.4-pve1
zfs set -- mountpoint=/x nosuch/ds      | rc=1   | cannot open 'nosuch/ds': dataset does not exist
zfs get -- all nosuch                   | rc=1   | cannot open 'nosuch': dataset does not exist
zfs create -s -V 1M -- nosuch/v         | rc=1   | cannot open 'nosuch': no such pool
zfs destroy -- nosuch/ds                | rc=1   | cannot open 'nosuch/ds': dataset does not exist
zfs rollback -- nosuch@s                | rc=1   | cannot open 'nosuch@s': dataset does not exist
zpool scrub -- nosuch                   | rc=1   | cannot open 'nosuch': no such pool
zpool scrub -s -- nosuch                | rc=1   | cannot open 'nosuch': no such pool
zpool trim -- nosuch                    | rc=255 | cannot open 'nosuch': no such pool
zpool upgrade -- nosuch                 | rc=1   | cannot open 'nosuch': no such pool
zpool import -- nosuch                  | rc=1   | cannot import 'nosuch': no such pool available
zpool import -f -- nosuch               | rc=1   | cannot import 'nosuch': no such pool available
zpool add -- nosuch sdz                 | rc=1   | cannot open 'nosuch': no such pool
zpool remove -- nosuch sdz              | rc=1   | cannot open 'nosuch': no such pool
zpool attach -- nosuch a b              | rc=1   | cannot open 'nosuch': no such pool
zpool replace -- nosuch a b             | rc=1   | cannot open 'nosuch': no such pool
zpool online -e -- nosuch a             | rc=1   | cannot open 'nosuch': no such pool
zpool export -- nosuch                  | rc=1   | cannot open 'nosuch': no such pool
zpool export -f -- nosuch               | rc=1   | cannot open 'nosuch': no such pool
zpool destroy -- nosuch                 | rc=1   | cannot open 'nosuch': no such pool
zpool labelclear -f -- /dev/nonexist    | rc=1   | failed to open /dev/nonexist: No such file or directory
zpool create -- nosuchp /dev/nonexist   | rc=1   | cannot resolve path '/dev/nonexist'
zpool set -- comment=x nosuch           | rc=2   | invalid option '-'
## after: pools -> gtbackup gtiscsi pvfix sysfix (unchanged)
```

Every subcommand reaches name resolution with `--` in place, except `zpool set`, which rejects `--` as an
option (rc=2, `invalid option '-'`). Note `zpool trim` reports a missing pool with rc=255, not 1.
Same OpenZFS version as the coordinator's host (2.4.4), same result.

**Verdict: PROVEN** (matches the coordinator's host: all accept `--` except `zpool set`).

---

## R6 — cr.11: the operator sees `<b>x</b>` as text (browser probe)

Spec saved as `tests/integration/alert-encoding.spec.ts` (reusable; no fixture needed beyond a logged-in PVE
UI). It logs in through PVE's own form (`loginToPve`), waits for the served bundle's `ANAS.runJob`, and drives
the two alert paths in `10-api.js` that every panel mutation goes through:

1. **jobRejected (400):** `POST /mounts` with mountpoint `/mnt/pve/<b>x</b>` — the daemon refuses with
   "Mountpoint '/mnt/pve/<b>x</b>' is PVE territory and off-limits to ANAS", echoing the typed input.
2. **pollJob `failed`:** `POST /shares/nfs` for the non-existent path `/srv/anas-alert-<b>x</b>` — the job fails
   in `exportfs -ra` with "Failed to stat /srv/anas-alert-<b>x</b>"; cr.13 rolls the file back.

Assertions on the real Ext.Msg box: its text contains the literal `<b>x</b>`, the box contains no `<b>` element,
and its HTML carries `&lt;b&gt;x&lt;/b&gt;`; for (2) `/etc/exports` sha256 is unchanged.

```
host$ npx playwright test tests/integration/alert-encoding.spec.ts --project=integration
  ✓ … a refused request (400) echoing <b>x</b> shows the literal text (2.5s)
  ✓ … a failed job whose error carries <b>x</b> shows the literal text (3.1s)
  2 passed (6.9s)
```

Mutation check (second and last run): the same spec with `ANAS.enc` replaced by identity in the page (the
pre-cr.11 behaviour), spec restored afterwards:

```
MUTANT {"text":"Mountpoint '/mnt/pve/x' is PVE territory …","boldCount":1,"html":"Mountpoint '/mnt/pve/<b>x</b>' is …"}
  ✘ … refused request …   Expected substring "/mnt/pve/<b>x</b>"  Received "Mountpoint '/mnt/pve/x' is PVE territory …"
MUTANT {"text":"exportfs: Failed to stat /srv/anas-alert-x: …","boldCount":1,"html":"exportfs: Failed to stat /srv/anas-alert-<b>x</b>: …"}
  ✘ … failed job …        Expected substring "Failed to stat /srv/anas-alert-<b>x</b>"  Received "…/srv/anas-alert-x…"
  2 failed
```

Run 3 (disclosed; over the brief's "at most twice"): eslint's `unicorn/prefer-dom-node-text-content` refused
`locator.innerText()`, so the spec reads `textContent()` like its siblings; re-run: 2 passed (6.3s), `/etc/exports`
unchanged, no `anas-alert` line.

So the spec fails when the encoding is missing (the operator would see a bold "x"). The failed-job alert also
carries the node's stale `/testpool/share1` line — R3-D1 seen from the UI.

iSCSI LUN grid / Disks SMART detail: NOT RUN in the browser — the node has no LIO stack
(`GET /iscsi/targets` → `installed:false`, no targets) and its QEMU disks report no SMART data
(`smartHealthy:null`). Static check of the SERVED bundle instead
(`/pve2/js/anas.js?v=775c347df7c4`): line 51282 `{ text: t('Name (SCSI model)'), …, renderer: ANAS.enc }` and
line 16030 `{ text: t('Raw'), …, renderer: ANAS.enc }` — both columns carry the encoder on the node.

**Verdict: PROVEN** (alert path, both branches; the LUN/SMART grids are confirmed only in the served bundle).

---

## R7 — `tests/integration/datasets-api.spec.ts` on the node (re-pointed to `PUT …/access` in d6892b3)

Fixture: the spec needs `testpool`. On this node `testpool` (mirror of ANAS_HOT1/ANAS_HOT2, both attached) was
EXPORTED, not destroyed (`zpool import` lists it ONLINE; `zfs-import@testpool` disabled). Imported by hand for
the row and exported again at the end:

```
# zpool import testpool   -> testpool ONLINE; testpool, testpool/share1 mounted
host$ npx playwright test tests/integration/datasets-api.spec.ts --project=integration     (run 1)
  ✓ GET /pools/testpool/datasets → 200 { data: [] } that includes testpool itself
  ✓ GET /identity/users → 200 non-empty array including root
  ✓ GET /identity/groups → 200 non-empty array including root
  ✓ full lifecycle through the API, verified against the real system (1.8s)
  ✓ a plain destroy of a parent with children fails; ?recursive=true removes the tree
  5 passed (5.6s)
(run 2) 5 passed (6.7s)
```

What the access editor really writes, for the spec's exact body, on a throwaway dataset by hand:

```
POST /pools/testpool/datasets {"path":"r7probe"}  -> completed; stat: root root 755
PUT  /pools/testpool/datasets/r7probe/access {"owner":"root","group":"root","entries":[
       {"kind":"owner","level":"read-write"},{"kind":"owning-group","level":"read-write"},{"kind":"everyone","level":"none"}]}
  -> completed {"aclEnabled":false,"aclAutoEnabled":false,"namedCount":0,"clearedNamed":false}
# stat -c '%U %G %a' /testpool/r7probe  -> root root 770
# getfacl -p  -> user::rwx group::rwx other::---
DELETE (confirm-gated) -> destroyed testpool/r7probe
```

The spec's `/^root root 2?770$/` was not wrong but hedged: no setgid bit is set for this body. Classified
**(a) stale/loose expectation** and pinned to `toBe('root root 770')` with the node fact in the comment; run 3
with the pinned expectation: 5 passed (7.7s). Then `zpool export testpool` (node back to its found state).

**Verdict: PROVEN** — the re-pointed spec is green on the node ×2 (×3 with the pinned mode).

---

## Node state at the end of the pass

| Item | Pre-pass | Post-pass |
|---|---|---|
| `/etc/fstab` sha256 | `b3c85fb4…23a3` | same |
| `/etc/exports` sha256 | `f1e3ca20…9743` (stale `/testpool/share1` line included) | same |
| `/etc/samba/smb.conf` sha256 | `46779719…ecea` | same |
| `/etc/exports.d/` | absent | absent |
| `/mnt`, `/srv` | `vzsnap0`; empty | same |
| NFS/CIFS/autofs mounts | binfmt_misc only | same |
| `/etc/anas/creds/` | `backup-repo-pbsgt.secret` | same |
| pools | gtbackup, gtiscsi, pvfix (loop2), sysfix (loop3); testpool exported | same pools; pvfix/sysfix re-attached by hand after the reboot on loop0/loop1 (`/var/tmp/pvepool-fixture/*.loop` updated), dataset list identical; testpool exported again |
| `/etc/pve/anas/remotes.json` | version 17, no remotes | version 19, no remotes (CAS counter; R4) |
| `AnyEvent.pm` | ADOCK block, then ANAS block (`f901b8cd…4974`) | ANAS block, then ADOCK block (`0aad1102…53b0`); ADOCK block byte-identical; module minus both blocks = package bytes (R5) |
| `index.html.tpl` | adock.js line, then anas.js line | anas.js line, then adock.js line |
| failed units | `zfs-import@anasactimport`, `zfs-import@anascomp` | same two (pre-existing) |
| uptime | 1 day 19 h | rebooted once for R1 |
| `/anas/`, `/adock/` | 401, 401 | 401, 401 |

Removed: the R1 NFS export (`/etc/exports.d/anasproof.exports`, `/srv/anasproof-nfs`, and the `exports.d` dir with
ZFS's lock file), three R1 mounts (via the API) plus the orphaned automount placeholder (by hand), the R2 Samba share
and its directory, the R2 mount and credentials file (via the API), the R3 exports and `/srv/anasproof-exp`, the R4
probe files and replication remote, the R5 package download, the R7 probe dataset, every `/root/anasproof-*` file.

## Summary

| Row | Verdict | One line |
|---|---|---|
| R0 deploy | PROVEN | `d525a3a` deployed (dist hashes match), anasd/anas/pveproxy active, `/anas/` 401 |
| R1 cr.6 | FAILED (c) for automount lines; PROVEN for plain lines | disabled `x-systemd.automount` line is armed at boot (`remote-fs.target.wants`) and on first access mounts; disable/remove of an armed automount leaves it live; plain + legacy `#ANAS` + byte-identical enable all good |
| R2 cr.2 | PROVEN (+ defect R2-D1 (c)) | `//127.0.0.1/anas\040proof /mnt/anas\040proof`, mounts, findmnt shows real path, list correct; detail lacks `fstabLine` |
| R3 cr.13 | PROVEN (+ defect R3-D1 (c)) | `1.2.3.4/99` rejected → file sha unchanged, `exportfs -v` matches; `[fe80::1]` accepted (node fact); a stale export line rolls back every ANAS export edit |
| R4 cr.14 | PROVEN | helper works on `/etc/pve/anas` and `/etc/pve/priv/anas`; fsyncs succeed; pmxcfs sets mode (640/600); remote create/delete lands |
| R5 cr.7 | PROVEN | uninstall leaves package bytes + ADOCK block exactly; reinstall restores `/anas/` |
| R6 cr.11 | PROVEN | `<b>x</b>` shown literally in both alert paths; mutant (no enc) fails the spec |
| R7 datasets-api | PROVEN | 5/5 ×2; editor writes `root root 770`; expectation pinned (a) |
| R8 `--` probe | PROVEN | zfs-2.4.4-pve1: all accept `--` except `zpool set` (`invalid option '-'`) |
