# Live re-proof — access.r1 (c466118): honest file modes on the recursive apply, `inherit acls`, the share door order, the grant level

Driven 2026-10-12 (UTC) against the disposable stunt PVE 9 node `anas-pve`. Code under test: main at
`c466118` (access.r1, the fix for F1, F2, F3 and F5 of `docs/LIVE-PROOF-0.4.3-access.md`), put on the
node with `./test/stunt-node/deploy-anas.sh` (daemon and gateway report `0.4.2`; anasd active since
00:29:51 UTC; §1 shows the four daemon files the commit changes have the same md5 on the node as in
the host build). Nothing in the product was changed for this proof.

**Method.** As the previous document: every mutation and every editor read went through the real
front door, the way the panels call it, with a PVE ticket for `root@pam` and
`https://localhost:8006/anas/api/nodes/anas-pve/v1<path>` with the `PVEAuthCookie` cookie and the
`CSRFPreventionToken` header (pveproxy → AnasProxy → gateway ticket check → anasd). Request bodies are
the ones the dialogs build (`70-shares.js` `submitSmbShare`, `14-permissions.js` `submitAccess`).
`api METHOD PATH [body] [X-Anas-Confirm]` prints the HTTP status, any `X-Anas-Confirm-Code` header and
the body; a job is polled until it ends and printed as its status, operation, last progress line,
result and error. A job keeps only its latest progress line, so where the brief asks for every
progress line a **sampler** ran alongside the confirmed request: a loop of `GET /v1/jobs?status=running`
on the daemon socket and `ps` for the acl/mode tools (both read-only), printed as the distinct lines in
first-seen order. The shell was used to observe (`getfacl`, `stat`, `find`, `zfs get`, `zpool history`,
`testparm`, `smbclient`, `runuser`, journald) and to make fixtures the API has no door for: files
written as root, a btrfs subvolume, the hand-written 0.4.2-shape stanzas of R4, the scratch stanzas
of the R3x diagnosis, and a throwaway `dir` storage (`pvesm add`/`remove`). Each fenced block is one
`ssh root@anas-pve 'bash -s'` run, verbatim (trailing blanks and repeated blank lines squeezed). The
helpers lived in `/root/rpproof` on the node and were removed at the end.

**Fixtures.** `ahrcache-fixture.sh up` attached three blank virtual disks (hot7 and hot8, 1 GiB, for
the AHR pool; hot9 unused) and `down` detached them at the end. Two share users, `rpuser` and
`rpuser2`, were made through the API. ZFS work used new datasets on `testpool` (`acltype=off`).

## Verdicts

| Scenario | Verdict |
|---|---|
| R1. Recursive apply on ZFS keeps file modes honest | **PROVEN, with a deviation from the brief** (§3). 409 naming the child dataset and its ACL switch, resend → 202, job completed with `childAclEnabled: ["testpool/rp1/kid"]`. Plain files (0644, 0600, the nested one, the one in the child dataset, 20,000 more in R1d) carry no execute bit; the 0755 script keeps x and still runs as `rpuser`; 0 regular files carry setgid, 0 directories lack it (child dataset included); `getfacl`: plain file `user:rpuser:rw-` + `mask::rw-`, script `user:rpuser:rwx`, directories `user:rpuser:rwx` + `default:` entries with lowercase x. Progress lines (R1b, R1d) echo the argv: `zfs set acltype=posixacl xattr=sa testpool/rp1`, `setfacl -R -b -m u::rwX,g::r-X,o::r-X,u:rpuser:rwX,m::rwX /testpool/rp1`, `setfacl -R -d --set u::rwx,g::r-x,o::r-x,u:rpuser:rwx,m::rwx /testpool/rp1`, `find /testpool/rp1 -type d -exec /usr/bin/chmod g+s {} +`; `ps` saw the same setfacl argv. Deviation: the 0744 file (owner-only execute) ends `-rwxrwxr-x` (RF2). |
| R2. The same on an AHR pool (btrfs) | **PROVEN** (§4). 409 with the subvolume sentence, resend → 202, job completed; plain files (top level, inside subvolume `sub1`, 20,000 under `bulk/`) carry no x; the 0755 script keeps x and runs as `rpuser`; 0 files setgid, 0 directories without; the same `getfacl` shapes; progress lines and `ps` show `setfacl -R -b -m …` and `setfacl -R -d --set …`, the last progress line is the `find … -type d` setgid step; `zpool history` unchanged on every pool. |
| R3. Two-user SMB write with `inherit acls` | **FAILED** (§5). `testparm` shows `inherit acls = Yes` and the grant applied, but A's file lands `-rwxr--r--` with `mask::r--` (`user:rpuser2:rwx #effective:r--`); B's overwrite and B's append are `NT_STATUS_ACCESS_DENIED`; B's directory gets `mask::r-x` and A's write into it is denied. Effective `create mask = 0744`, `directory mask = 0755`. R3x: with `create mask = 0666`/`directory mask = 0777` both writes succeed whether `inherit acls` is yes or no. RF1. |
| R4. Pre-existing stanza | **PROVEN** (§6). (a) a no-grant edit resending the stanza's values → smb.conf byte-identical (`cmp`); a no-grant comment edit → a one-line diff, no `inherit acls`. (b) a granting edit → diff is the `valid users` line plus `inherit acls = yes` appended as the stanza's last line, nothing moved; a second granting edit does not add it again (count 1). (c) the `inherit acls = no` stanza edited with a grant → only `valid users` changes; testparm still `No`. |
| R5. Share door ordering | **PROVEN** (§7). `POST /shares/smb` with `applyToExisting` on `/srv/rpproof` (ext4, `dir` storage inside) → 202, no 409, no confirm code; share created; `grant.status: "refused"`, "Recursive permission change of '/srv/rpproof' would include /srv/rpproof/store — the path of PVE storage 'rpstore'"; ACL unchanged. The editor door's recursive PUT → 400 with the same sentence. The share door's edit with a recursive grant → 202, no 409, the same refusal. |
| R6. Grant result level | **PROVEN** (§8). The read-only edit's `grant.granted` reports `read-write` for both users; the ACL keeps `user:rpuser:rwx` and `user:rpuser2:rwx`. |
| R7. Repair command | **PROVEN** (§9). After `chmod -R a+x,g+s` all 20,007 files carry x and setgid; after `find /testpool/rp1 -type f -exec chmod a-x,g-s {} +` 0 files carry any x or setgid (the child dataset's included) and 0 of 5 directories lack setgid or x. On a file damaged exactly as the old writer did, the named entry stays `rwx` and is clamped by `mask::rw-` (`#effective:rw-`); the named user can write and cannot execute. |
| R8. Teardown | **PROVEN** (§10). Shares, users, datasets, the AHR pool and its empty mountpoint directory, the throwaway storage and directories removed; disks detached; smb.conf, `/etc/exports` and `/etc/fstab` have the md5 they had before the deploy, `storage.cfg` differs only by PVE's own re-ordering of `content` lists (note in the decisions); `anasd anas smbd` active, NRestarts 0, `/v1/health` ok on the socket and through the front door, 0 warning-or-worse lines from anasd or the gateway since the deploy; the node runs `c466118`. The first teardown run removed nothing because of a fault in my helper call (§10, kept verbatim). |

## Findings

**RF1 — F2 is not fixed: `inherit acls = yes` does not let a second granted user write what the first
saved over SMB.** §5: the share `rp3` is written with `inherit acls = Yes` (testparm), the grant
applied (`user:rpuser:rwx`, `user:rpuser2:rwx`, default entries the same, `default:mask::rwx`). A's
`put` lands `rpuser:root -rwxr--r--` with `mask::r--`, so `user:rpuser2:rwx #effective:r--`; B's `put`
over it and B's `reput` are `NT_STATUS_ACCESS_DENIED` and the file still holds A's text. B's `mkdir`
lands `drwxr-sr-x` with `mask::r-x`; A's `put` into it is `NT_STATUS_ACCESS_DENIED`. The share's
effective `create mask` is `0744` and `directory mask` `0755` (Samba's defaults; the stanza sets
neither). This is the same picture as F2 in the previous document, `inherit acls` or not. The R3x
diagnosis (scratch stanzas on directories inside `rp3`, removed afterwards): `inherit acls = yes` with
`create mask = 0666` and `directory mask = 0777` → A's file `-rw-rw-r--`, `mask::rw-`, B's overwrite
succeeds; B's directory `drwxrwsr-x`, `mask::rwx`, A's write into it succeeds. The same masks with
`inherit acls = no` give the same result. `create mask = 0777` makes every SMB-saved file
`-rwxrwxr-x`, executable by all. So on this Samba (4.22.11) the masks decide what the other granted
users get, and `inherit acls` makes no measurable difference to these writes. My reading, consistent
with all three variants but not checked against Samba's source: smbd creates the file with
`0777 & create mask` (the directory with `0777 & directory mask`), and the kernel clamps the inherited
ACL's mask entry with that mode's group bits. Not fixed. The release notes (0.4.3, "New files and
folders inherit the grant, including those saved over SMB … Shares made before this release get that
the next time an edit grants access") and DESIGN's "SMB inheritance" sentence ("files created over
SMB take the directory's default ACL instead of Samba's `create mask`") state the outcome this run
disproves. The direction the diagnosis supports is a decision for the owner: what `create mask` /
`directory mask` an ANAS-written stanza should carry (0666/0777 gave the intended result without
making files executable; 0777 for files did not), and whether `inherit acls` is still wanted.

**RF2 — A file executable by its owner only becomes executable by everyone.** §3: `owner-x.txt`,
`root:root 0744`, ends `-rwxrwxr-x` with `user:rpuser:rwx`, `group::r-x`, `other::r-x`, `mask::rwx`
(R1c, and again after the second apply in R1d). The script (0755) is unchanged in class, and plain
files get no x, so F1 itself is fixed. This is how capital `X` works (setfacl(1): execute "only if the
file is a directory or already has execute permission for some user"), the same rule as chmod's `X`;
the brief's "every regular file keeps its execute bits exactly as before" does not hold for a file
whose execute bits differ by class. The release-note sentence ("gives execute only to folders and to
files that already had it") is true at the level of files. Whether the widening is acceptable is the
owner's call; it was not visible on the previous proof's fixtures (all 0644 or 0755).

**Note — the recursive apply's base levels reach every file.** §3: `private.txt` (0600) ends
`-rw-rw-r--` (`other::r--`, `user:rpuser:rw-`): the declarative spec sets owner, owning group and
everyone on every file, as the 409's headline says. Not new in access.r1 (the earlier writer's
`--set` did the same); stated because a 0600 file turning world-readable may surprise.

**Note — SMB-saved files carry owner execute.** §5 and the previous proof's §1: every file a user
saves over SMB on a share without its own masks is `-rwxr--r--` (`create mask = 0744`, Samba's
default; with `create mask = 0666` in R3x the owner x is gone). This is outside the recursive apply
F1 fixed, but it is the same symptom on new files, and it would be settled by the same mask decision
as RF1.

## Decisions taken where the brief was open or did not match the node

- **Which node.** `test/stunt-node/config.sh` names the VM `anas-pve` and `ssh.sh` reaches it; the
  node answered `hostname` → `anas-pve` before anything ran, the same node the previous document
  names. Every node command went through `ssh.sh`; the only host-side actions were the build, the
  rsync of `deploy-anas.sh` and the fixture script's `virsh` attach/detach for this VM's disks.
- **Deploy.** The previous document's method: `deploy-anas.sh` from this worktree (after `npm ci`
  and copying the gitignored `config.local` in, which a fresh worktree lacks). The version string
  stays `0.4.2` (not bumped yet), so §1 proves the build by md5 of the four changed daemon files.
- **Progress lines.** A job keeps only its last progress line, and the R1 tree is too small for any
  sampler: R1b's caught only the `zfs set` and the final `find`. Rather than call that a pass, R1d
  ran the same confirmed apply over 20,000 more plain files, which caught every line and the setfacl
  argv from `ps`; R2's tree carried the 20,000 files from the start.
- **R1's dataset.** A new dataset on `testpool` (`acltype=off`), so the child dataset's ACL switch
  ran on the same apply. R1's verdict is "PROVEN, with a deviation" rather than FAILED because every
  concrete criterion the brief spelled out in parentheses holds and the one file that departs does so
  by `X`'s documented rule (RF2); the brief's general wording is not met for it, and that is said.
- **R3 failed; the run continued.** The brief says a failed B write is a finding, not something to
  fix, and its general rule says record and stop; I read "stop" as "stop short of fixing" and ran
  R4–R8, which do not depend on R3. Beyond the brief, R3x tried three scratch stanzas by hand to
  locate the cause, in the manner of the previous document's §3x; smb.conf was restored to the same
  bytes (md5 shown) and no product file changed.
- **R4.** The stanzas were written by hand into `/etc/samba/smb.conf`, the path `server.ts` gives the
  share routes, in the shape 0.4.2's `renderStanza` wrote (path, comment, browseable, read only, guest
  ok, valid users). (a) ran twice: an edit that resends the stanza's own values (whole file
  byte-identical) and one that changes the comment (one-line diff), because an edit that changes
  something cannot leave the stanza literally byte-identical. A second granting edit was added to show
  the line is not duplicated.
- **R5.** The share door's edit (`PUT /shares/smb/rp5` with a recursive grant) was added; it takes
  the same order as the create.
- **R6** reused the R3 share (both users already read-write).
- **R7** used the R1 tree, so the repair crosses a mounted child dataset as the release note says;
  R7b added one file damaged with the old writer's exact spec, because a hand `chmod a+x` moves only
  the mask.
- **R8.** The first teardown run passed each confirm code in the body slot of my helper; pveproxy
  answered 501 to every resend and nothing ANAS manages was removed (the shell steps in that run, the
  throwaway storage and `/srv/rpproof`, did run). Both runs are kept verbatim. AHR destroy leaves the
  empty mountpoint directory; I removed `/mnt/anas-ahr/rpahr` by hand (see below).
- **storage.cfg.** Its md5 differs from the one taken before the deploy. The proof added and removed
  only `rpstore`, and `pvesm` rewrote the file: the `content` lists of `local` and `pvfix` now read
  `vztmpl,rootdir,snippets,images,backup,iso` and `images,rootdir`, where the previous document's §6
  shows `iso,vztmpl,images,rootdir,backup,snippets` and `rootdir,images`, the same sets in another
  order. No copy of the earlier bytes was kept, so this rests on that comparison.
- **Redaction.** The previous document names the node and gives its address; this brief forbids
  addresses, so this document names the node (`anas-pve`, part of every API path and of
  `test/stunt-node/config.sh`) and leaves the address out. No listing of the node's own accounts was
  printed; the test users are `rpuser` and `rpuser2`.

## Noticed on the node and in the code (outside the scenarios)

- AHR destroy leaves `/mnt/anas-ahr/<name>` behind as an empty directory. After this run
  `/mnt/anas-ahr/` still holds 16 directories from earlier runs, none mounted, 15 of them empty
  (`lpahr` holds one entry), among them `accahr` from the previous proof (its teardown does not list
  it). Only `rpahr` was removed here.
- `/etc/samba/smb.conf` on the node has two `[share1]` sections (seen before the deploy; untouched).
- `inherit acls = Yes` is written on a new stanza even when its grant is refused (R5's `rp5`); that is
  what access.r1 says ("every create"), stated because RF1 makes the line's value doubtful.
- R4b-2 removed `rpuser2` from `valid users` with the grant on; `rpuser2`'s ACL entry stayed (the
  ruled "a grant never revokes"), as expected.

## §1 — The build on the node

```
### 1. the build on the node

$ systemctl is-active anasd anas smbd; systemctl show -p NRestarts --value anasd; systemctl show -p ActiveEnterTimestamp --value anasd
active
active
active
0
Mon 2026-10-12 00:29:51 UTC

$ curl -s --unix-socket /run/anas/anasd.sock http://localhost/v1/health; echo
{"status":"ok","version":"0.4.2"}

$ api GET /health
HTTP 200
{
  "status": "ok",
  "version": "0.4.2"
}

(the four daemon files c466118 changes, as running on the node; the host build gave the same four sums)

$ cd /opt/anas/packages/daemon/dist && md5sum services/access.js parsers/smb-conf.js parsers/getfacl.js routes/shares-smb.js
29ef3cdc566d7a8600bcb41ffc4bb363  services/access.js
ff8634c23cf469bd957996023e777176  parsers/smb-conf.js
dcaf344ca50463eeb2094170d6b6631c  parsers/getfacl.js
6109770b49c418af0f6bb70723db6e71  routes/shares-smb.js

$ grep -n "const setArgs = recursive" /opt/anas/packages/daemon/dist/services/access.js; grep -n "add(PARAM.inheritAcls" /opt/anas/packages/daemon/dist/parsers/smb-conf.js
695:            const setArgs = recursive ? ['-R', '-b', '-m', spec, mountpoint] : ['--set', spec, mountpoint];
842:    add(PARAM.inheritAcls, 'yes');

$ dpkg -s acl samba coreutils findutils | grep -E "^(Package|Version)"; zfs version | head -1
Package: acl
Version: 2.3.2-2+b1
Package: samba
Version: 2:4.22.11+dfsg-0+deb13u1
Package: coreutils
Version: 9.7-3
Package: findutils
Version: 4.10.0-3
zfs-2.4.4-pve1
```

## §2 — Fixtures

The `ls … | grep` line below prints nothing because its pattern anchored the name at the end of the
line, where `ls -l` prints the link target; `wipefs` printing no signature (0 lines) is the blank
check, and R2a lists the three by-id links with a corrected pattern.

```
### 2. fixtures: two share users through the API; the blank AHR disks

$ date -u "+%Y-%m-%d %H:%M:%S"
2026-10-12 00:32:13

$ api POST /identity/users '{"name":"rpuser","smbPassword":"Rp-proof-1"}'
HTTP 202
{
  "job": {
    "id": "4e786f49-9e2c-42dc-9a03-a6c2037a58c0",
    "status": "running",
    "operation": "identity.user.add",
    "createdAt": "2026-10-12T00:32:13.396Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/4e786f49-9e2c-42dc-9a03-a6c2037a58c0   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "identity.user.add",
  "progress": "Setting SMB password for 'rpuser'",
  "result": {
    "created": "rpuser",
    "smbEnabled": true
  },
  "error": null
}

$ api POST /identity/users '{"name":"rpuser2","smbPassword":"Rp-proof-2"}'
HTTP 202
{
  "job": {
    "id": "09ba96d2-6ba2-4de5-bdeb-7d0fc1d39147",
    "status": "running",
    "operation": "identity.user.add",
    "createdAt": "2026-10-12T00:32:13.998Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/09ba96d2-6ba2-4de5-bdeb-7d0fc1d39147   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "identity.user.add",
  "progress": "Setting SMB password for 'rpuser2'",
  "result": {
    "created": "rpuser2",
    "smbEnabled": true
  },
  "error": null
}

$ id rpuser; id rpuser2; pdbedit -L | grep "^rpuser"
uid=1004(rpuser) gid=100(users) groups=100(users)
uid=1005(rpuser2) gid=100(users) groups=100(users)
rpuser:1004:
rpuser2:1005:

$ ls -l /dev/disk/by-id/ | grep -E "ANAS_HOT(7|8|9)$" | awk "{print \$9, \$10, \$11}"; wipefs /dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT7 /dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT8 | wc -l
0
```

## §3 — R1: recursive apply on ZFS keeps file modes honest

**Pass criteria, stated before the run.** On a fresh dataset `testpool/rp1` with a child dataset
`rp1/kid` mounted beneath it, a tree of a plain 0644 file, a 0755 shell script owned by root, a 0744
file, a 0600 file, a nested directory with a plain file and a plain file in the child dataset; a
named read-write grant to `rpuser` with `applyToExisting` through `PUT
/pools/testpool/datasets/rp1/access` answers 409 with a confirm code, and the resend runs. Then:
every regular file keeps its execute bits exactly as before (the script still carries x, the plain
files carry none); no regular file carries setgid; every directory carries setgid; `getfacl` on a
plain file shows `user:rpuser:rw-` with `mask::rw-`, on the script `user:rpuser:rwx`, on a
directory `user:rpuser:rwx` plus the `default:` entries with lowercase x; the script runs as
`rpuser` under `runuser`; the job's progress lines echo the argv that ran, including `-R -b -m`.

R1a builds the tree, R1b is the 409 and the confirmed apply, R1c reads the result. The sampler in
R1b (job list over the daemon socket plus `ps` for the acl/mode tools, both read-only, in a loop)
caught only the `zfs set` and the final `find` line: on nine files each setfacl walk is over
before one sample. R1d therefore ran the same confirmed apply again with 20,000 more plain files
under `bulk/`, which made every step long enough to sample; it is the record of the progress lines
and the argv, and it re-checks the modes after a second apply.

```
### R1a. a fresh dataset with a child dataset beneath it (API), and the tree (shell, as root)

$ api POST /pools/testpool/datasets '{"path":"rp1"}'
HTTP 202
{
  "job": {
    "id": "a64e1dc2-0515-4161-b6ae-b0aec2d0f642",
    "status": "running",
    "operation": "zfs.create",
    "createdAt": "2026-10-12T00:32:41.092Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/a64e1dc2-0515-4161-b6ae-b0aec2d0f642   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "zfs.create",
  "progress": null,
  "result": {
    "created": "testpool/rp1"
  },
  "error": null
}

$ api POST /pools/testpool/datasets '{"path":"rp1/kid"}'
HTTP 202
{
  "job": {
    "id": "a7f39193-931e-4faf-a500-e21e9c840343",
    "status": "running",
    "operation": "zfs.create",
    "createdAt": "2026-10-12T00:32:41.413Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/a7f39193-931e-4faf-a500-e21e9c840343   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "zfs.create",
  "progress": null,
  "result": {
    "created": "testpool/rp1/kid"
  },
  "error": null
}

$ cd /testpool/rp1 && echo plain > plain.txt && chmod 0644 plain.txt && printf "%s\n" "#!/bin/sh" "echo run.sh ran as \$(id -un)" > run.sh && chmod 0755 run.sh && echo owner-x > owner-x.txt && chmod 0744 owner-x.txt && echo private > private.txt && chmod 0600 private.txt && mkdir sub && echo inner > sub/inner.txt && chmod 0644 sub/inner.txt && echo kid > kid/kid.txt && chmod 0644 kid/kid.txt

$ cat /testpool/rp1/run.sh
#!/bin/sh
echo run.sh ran as $(id -un)

$ zfs list -r -H -o name,mountpoint,acltype testpool/rp1
testpool/rp1	/testpool/rp1	off
testpool/rp1/kid	/testpool/rp1/kid	off

$ find /testpool/rp1 -printf "%M %u:%g %p\n" | sort -k3
drwxr-xr-x root:root /testpool/rp1
drwxr-xr-x root:root /testpool/rp1/kid
-rw-r--r-- root:root /testpool/rp1/kid/kid.txt
-rwxr--r-- root:root /testpool/rp1/owner-x.txt
-rw-r--r-- root:root /testpool/rp1/plain.txt
-rw------- root:root /testpool/rp1/private.txt
-rwxr-xr-x root:root /testpool/rp1/run.sh
drwxr-xr-x root:root /testpool/rp1/sub
-rw-r--r-- root:root /testpool/rp1/sub/inner.txt

$ getfacl -pR /testpool/rp1 2>&1 | grep -c "^user:\|^default:"
9
```

```
### R1b. the editor door, recursive named grant: 409, then the resend; every progress line sampled

$ getfacl -pR /testpool/rp1 2>/dev/null | grep -cE "^user:[a-z]|^group:[a-z]|^default:"
0

--- no confirm header

$ api PUT /pools/testpool/datasets/rp1/access '{"owner":"root","group":"root","entries":[{"kind":"owner","level":"read-write"},{"kind":"owning-group","level":"read"},{"kind":"everyone","level":"read"},{"kind":"user","name":"rpuser","level":"read-write"}],"applyToExisting":true}'
HTTP 409
X-Anas-Confirm-Code: fc30a8ea1be2
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Applying to existing files rewrites the permissions of every file and directory under '/testpool/rp1'",
    "warnings": [
      "It crosses the child datasets mounted under '/testpool/rp1': testpool/rp1/kid (/testpool/rp1/kid).",
      "POSIX ACLs (acltype=posixacl) are switched on first for testpool/rp1/kid, as for 'testpool/rp1' itself.",
      "The current permissions are not recorded anywhere, so this cannot be undone."
    ]
  }
}

$ zfs list -r -H -o name,acltype testpool/rp1; getfacl -pR /testpool/rp1 2>/dev/null | grep -cE "^user:[a-z]|^default:"
testpool/rp1	off
testpool/rp1/kid	off
0

--- resend with the code (sampler running alongside)

$ api PUT /pools/testpool/datasets/rp1/access '{"owner":"root","group":"root","entries":[{"kind":"owner","level":"read-write"},{"kind":"owning-group","level":"read"},{"kind":"everyone","level":"read"},{"kind":"user","name":"rpuser","level":"read-write"}],"applyToExisting":true}'   [X-Anas-Confirm: fc30a8ea1be2]
HTTP 202
{
  "job": {
    "id": "31535acc-02b2-4d52-8152-be2ec6d63b9e",
    "status": "running",
    "operation": "fs.setAccess",
    "createdAt": "2026-10-12T00:32:54.019Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/31535acc-02b2-4d52-8152-be2ec6d63b9e   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "fs.setAccess",
  "progress": "find /testpool/rp1 -type d -exec /usr/bin/chmod g+s {} +",
  "result": {
    "dataset": "testpool/rp1",
    "mountpoint": "/testpool/rp1",
    "aclEnabled": true,
    "aclAutoEnabled": true,
    "namedCount": 1,
    "childAclEnabled": [
      "testpool/rp1/kid"
    ]
  },
  "error": null
}

$ (sampler: progress lines of running jobs and argv of the acl/mode tools, distinct, first-seen order)
argv      /usr/sbin/zfs list -H -o name,mountpoint
progress  fs.setAccess  (null)
progress  fs.setAccess  zfs set acltype=posixacl xattr=sa testpool/rp1
progress  fs.setAccess  find /testpool/rp1 -type d -exec /usr/bin/chmod g+s {} +
```

```
### R1c. the tree after the confirmed recursive apply

$ zfs list -r -H -o name,acltype,xattr testpool/rp1; zfs get -H -o name,property,value,source acltype testpool/rp1 testpool/rp1/kid
testpool/rp1	posix	sa
testpool/rp1/kid	posix	sa
testpool/rp1	acltype	posix	local
testpool/rp1/kid	acltype	posix	local

$ find /testpool/rp1 -printf "%M %u:%g %p\n" | sort -k3
drwxrwsr-x root:root /testpool/rp1
drwxrwsr-x root:root /testpool/rp1/kid
-rw-rw-r-- root:root /testpool/rp1/kid/kid.txt
-rwxrwxr-x root:root /testpool/rp1/owner-x.txt
-rw-rw-r-- root:root /testpool/rp1/plain.txt
-rw-rw-r-- root:root /testpool/rp1/private.txt
-rwxrwxr-x root:root /testpool/rp1/run.sh
drwxrwsr-x root:root /testpool/rp1/sub
-rw-rw-r-- root:root /testpool/rp1/sub/inner.txt

(regular files carrying setgid; directories NOT carrying setgid; regular files whose execute bits were none before but carry any now)

$ find /testpool/rp1 -type f -perm /2000 | wc -l; find /testpool/rp1 -type d ! -perm -2000 | wc -l; find /testpool/rp1 -type f -perm /111 -printf "%M %p\n" | sort -k2
0
0
-rwxrwxr-x /testpool/rp1/owner-x.txt
-rwxrwxr-x /testpool/rp1/run.sh

$ getfacl -p /testpool/rp1/plain.txt /testpool/rp1/run.sh /testpool/rp1/owner-x.txt /testpool/rp1/private.txt
# file: /testpool/rp1/plain.txt
# owner: root
# group: root
user::rw-
user:rpuser:rw-
group::r--
mask::rw-
other::r--

# file: /testpool/rp1/run.sh
# owner: root
# group: root
user::rwx
user:rpuser:rwx
group::r-x
mask::rwx
other::r-x

# file: /testpool/rp1/owner-x.txt
# owner: root
# group: root
user::rwx
user:rpuser:rwx
group::r-x
mask::rwx
other::r-x

# file: /testpool/rp1/private.txt
# owner: root
# group: root
user::rw-
user:rpuser:rw-
group::r--
mask::rw-
other::r--

$ getfacl -p /testpool/rp1 /testpool/rp1/sub /testpool/rp1/kid
# file: /testpool/rp1
# owner: root
# group: root
# flags: -s-
user::rwx
user:rpuser:rwx
group::r-x
mask::rwx
other::r-x
default:user::rwx
default:user:rpuser:rwx
default:group::r-x
default:mask::rwx
default:other::r-x

# file: /testpool/rp1/sub
# owner: root
# group: root
# flags: -s-
user::rwx
user:rpuser:rwx
group::r-x
mask::rwx
other::r-x
default:user::rwx
default:user:rpuser:rwx
default:group::r-x
default:mask::rwx
default:other::r-x

# file: /testpool/rp1/kid
# owner: root
# group: root
# flags: -s-
user::rwx
user:rpuser:rwx
group::r-x
mask::rwx
other::r-x
default:user::rwx
default:user:rpuser:rwx
default:group::r-x
default:mask::rwx
default:other::r-x

$ getfacl -p /testpool/rp1/sub/inner.txt /testpool/rp1/kid/kid.txt
# file: /testpool/rp1/sub/inner.txt
# owner: root
# group: root
user::rw-
user:rpuser:rw-
group::r--
mask::rw-
other::r--

# file: /testpool/rp1/kid/kid.txt
# owner: root
# group: root
user::rw-
user:rpuser:rw-
group::r--
mask::rw-
other::r--

--- the script still runs as the named user; the named user can write a plain file and not execute it

$ runuser -u rpuser -- /testpool/rp1/run.sh
run.sh ran as rpuser

$ runuser -u rpuser -- sh -c "echo appended-by-rpuser >> /testpool/rp1/plain.txt" && tail -1 /testpool/rp1/plain.txt
appended-by-rpuser

$ runuser -u rpuser -- /testpool/rp1/plain.txt; echo exit=$?
runuser: failed to execute /testpool/rp1/plain.txt: Permission denied
exit=1

$ runuser -u rpuser -- sh -c "echo new > /testpool/rp1/sub/by-rpuser.txt; mkdir /testpool/rp1/sub/rpdir" && getfacl -p /testpool/rp1/sub/by-rpuser.txt /testpool/rp1/sub/rpdir && stat -c "%A %U:%G %n" /testpool/rp1/sub/by-rpuser.txt /testpool/rp1/sub/rpdir
# file: /testpool/rp1/sub/by-rpuser.txt
# owner: rpuser
# group: root
user::rw-
user:rpuser:rwx	#effective:rw-
group::r-x	#effective:r--
mask::rw-
other::r--

# file: /testpool/rp1/sub/rpdir
# owner: rpuser
# group: root
# flags: -s-
user::rwx
user:rpuser:rwx
group::r-x
mask::rwx
other::r-x
default:user::rwx
default:user:rpuser:rwx
default:group::r-x
default:mask::rwx
default:other::r-x

-rw-rw-r-- rpuser:root /testpool/rp1/sub/by-rpuser.txt
drwxrwsr-x rpuser:root /testpool/rp1/sub/rpdir
```

```
### R1d. the same recursive apply again, over 20,000 more plain files, so every step lives long enough to be sampled

$ mkdir /testpool/rp1/bulk && cd /testpool/rp1/bulk && seq -f "f%05g" 1 20000 | xargs touch && find /testpool/rp1/bulk -type f | wc -l && stat -c "%A" /testpool/rp1/bulk/f00001
20000
-rw-rw-r--

$ api PUT /pools/testpool/datasets/rp1/access '{"owner":"root","group":"root","entries":[{"kind":"owner","level":"read-write"},{"kind":"owning-group","level":"read"},{"kind":"everyone","level":"read"},{"kind":"user","name":"rpuser","level":"read-write"}],"applyToExisting":true}'
HTTP 409
X-Anas-Confirm-Code: 199d7baa3b5e
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Applying to existing files rewrites the permissions of every file and directory under '/testpool/rp1'",
    "warnings": [
      "It crosses the child datasets mounted under '/testpool/rp1': testpool/rp1/kid (/testpool/rp1/kid).",
      "The current permissions are not recorded anywhere, so this cannot be undone."
    ]
  }
}

$ api PUT /pools/testpool/datasets/rp1/access '{"owner":"root","group":"root","entries":[{"kind":"owner","level":"read-write"},{"kind":"owning-group","level":"read"},{"kind":"everyone","level":"read"},{"kind":"user","name":"rpuser","level":"read-write"}],"applyToExisting":true}'   [X-Anas-Confirm: 199d7baa3b5e]
HTTP 202
{
  "job": {
    "id": "40419305-b40c-4c12-8dc0-8a1cc697f137",
    "status": "running",
    "operation": "fs.setAccess",
    "createdAt": "2026-10-12T00:34:06.326Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/40419305-b40c-4c12-8dc0-8a1cc697f137   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "fs.setAccess",
  "progress": "find /testpool/rp1 -type d -exec /usr/bin/chmod g+s {} +",
  "result": {
    "dataset": "testpool/rp1",
    "mountpoint": "/testpool/rp1",
    "aclEnabled": true,
    "aclAutoEnabled": false,
    "namedCount": 1,
    "childAclEnabled": []
  },
  "error": null
}

$ (sampler: progress lines of running jobs and argv of the acl/mode tools, distinct, first-seen order)
progress  fs.setAccess  (null)
argv      /usr/bin/setfacl -R -b -m u::rwX,g::r-X,o::r-X,u:rpuser:rwX,m::rwX /testpool/rp1
progress  fs.setAccess  setfacl -R -b -m u::rwX,g::r-X,o::r-X,u:rpuser:rwX,m::rwX /testpool/rp1
progress  fs.setAccess  setfacl -R -d --set u::rwx,g::r-x,o::r-x,u:rpuser:rwx,m::rwx /testpool/rp1
argv      /usr/bin/setfacl -R -d --set u::rwx,g::r-x,o::r-x,u:rpuser:rwx,m::rwx /testpool/rp1
progress  fs.setAccess  find /testpool/rp1 -type d -exec /usr/bin/chmod g+s {} +

$ find /testpool/rp1 -type f -perm /111 -printf "%M %p\n" | sort -k2; find /testpool/rp1 -type f -perm /2000 | wc -l; find /testpool/rp1 -type d ! -perm -2000 | wc -l; find /testpool/rp1/bulk -type f ! -perm 0664 | wc -l
-rwxrwxr-x /testpool/rp1/owner-x.txt
-rwxrwxr-x /testpool/rp1/run.sh
0
0
0

$ getfacl -p /testpool/rp1/bulk/f20000
# file: /testpool/rp1/bulk/f20000
# owner: root
# group: root
user::rw-
user:rpuser:rw-
group::r--
mask::rw-
other::r--
```

## §4 — R2: the same on an AHR pool (btrfs)

**Pass criteria, stated before the run.** The R1 criteria, on a new AHR-1 pool `rpahr` (hot7 + hot8)
whose data mount holds a plain 0644 file, a 0755 script and a btrfs subvolume `sub1` with a plain
file in it, through `PUT /ahr/rpahr/access`. In addition, as on the previous proof: no `zfs set`
runs (every pool's `zpool history` line count unchanged). Learning from R1, the tree carries 20,000
empty plain files under `bulk/` from the start, so the one confirmed apply is also the sampled one.

```
### R2a. an AHR-1 pool on the two blank fixture disks (API), and the tree (shell, as root)

$ ls -l /dev/disk/by-id/ | grep -E "ANAS_HOT(7|8|9) " | awk "{print \$9, \$10, \$11}"
scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT7 -> ../../sdd
scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT8 -> ../../sde
scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9 -> ../../sdf

$ api POST /ahr '{"name":"rpahr","tier":"ahr1","disks":["scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT7","scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT8"]}'
HTTP 409
X-Anas-Confirm-Code: 87ed9fca201e
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Creating AHR pool 'rpahr' will WIPE 2 disk(s). All data on them will be permanently erased",
    "warnings": [
      "scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT7 (QEMU HARDDISK, 1 GiB) will be completely erased",
      "scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT8 (QEMU HARDDISK, 1 GiB) will be completely erased"
    ]
  }
}

$ api POST /ahr '{"name":"rpahr","tier":"ahr1","disks":["scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT7","scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT8"]}'   [X-Anas-Confirm: 87ed9fca201e]
HTTP 202
{
  "job": {
    "id": "e0253d37-1c9e-44b1-b754-a94e18fac2dc",
    "status": "running",
    "operation": "ahr.create",
    "createdAt": "2026-10-12T00:35:08.535Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/e0253d37-1c9e-44b1-b754-a94e18fac2dc   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "ahr.create",
  "progress": "Notifying PVE",
  "result": {
    "created": "rpahr",
    "mountpoint": "/mnt/anas-ahr/rpahr",
    "arrays": [
      "rpahr-r1"
    ]
  },
  "error": null
}

$ findmnt -n -o TARGET,SOURCE,FSTYPE /mnt/anas-ahr/rpahr
/mnt/anas-ahr/rpahr /dev/mapper/rpahr-rpahr--vol[/@data] btrfs

$ cd /mnt/anas-ahr/rpahr && echo plain > plain.txt && chmod 0644 plain.txt && printf "%s\n" "#!/bin/sh" "echo tool.sh ran as \$(id -un)" > tool.sh && chmod 0755 tool.sh && btrfs subvolume create sub1 && echo insub > sub1/insub.txt && chmod 0644 sub1/insub.txt && mkdir bulk && cd bulk && seq -f "f%05g" 1 20000 | xargs touch && chmod 0644 f*
Create subvolume './sub1'

$ btrfs subvolume list /mnt/anas-ahr/rpahr | sed "s/^ID [0-9]* gen [0-9]* top level [0-9]* //"
path @data
path @snapshots
path sub1

$ find /mnt/anas-ahr/rpahr -path "*/bulk/*" -prune -o -printf "%M %u:%g %p\n" | sort -k3; find /mnt/anas-ahr/rpahr/bulk -type f ! -perm 0644 | wc -l
drwxr-xr-x root:root /mnt/anas-ahr/rpahr
drwxr-xr-x root:root /mnt/anas-ahr/rpahr/bulk
-rw-r--r-- root:root /mnt/anas-ahr/rpahr/plain.txt
drwxr-xr-x root:root /mnt/anas-ahr/rpahr/sub1
-rw-r--r-- root:root /mnt/anas-ahr/rpahr/sub1/insub.txt
-rwxr-xr-x root:root /mnt/anas-ahr/rpahr/tool.sh
0

$ getfacl -pR /mnt/anas-ahr/rpahr 2>/dev/null | grep -cE "^user:[a-z]|^group:[a-z]|^default:"
0
```

```
### R2b. the AHR editor door, recursive named grant: 409, the resend (sampled), the tree after

$ cat /root/rpproof/hist-before
gtbackup 908
gtiscsi 66
pvfix 252
sysfix 10
testpool 331

$ api PUT /ahr/rpahr/access '{"owner":"root","group":"root","entries":[{"kind":"owner","level":"read-write"},{"kind":"owning-group","level":"read"},{"kind":"everyone","level":"read"},{"kind":"user","name":"rpuser","level":"read-write"}],"applyToExisting":true}'
HTTP 409
X-Anas-Confirm-Code: bd8969a15c91
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Applying to existing files rewrites the permissions of every file and directory under '/mnt/anas-ahr/rpahr'",
    "warnings": [
      "On a Hybrid RAID pool it sweeps every subvolume under the pool's data as one tree; the pool's snapshots are not touched.",
      "The current permissions are not recorded anywhere, so this cannot be undone."
    ]
  }
}

$ api PUT /ahr/rpahr/access '{"owner":"root","group":"root","entries":[{"kind":"owner","level":"read-write"},{"kind":"owning-group","level":"read"},{"kind":"everyone","level":"read"},{"kind":"user","name":"rpuser","level":"read-write"}],"applyToExisting":true}'   [X-Anas-Confirm: bd8969a15c91]
HTTP 202
{
  "job": {
    "id": "fbac35c0-2ef5-4ea6-85c1-f746e16bf433",
    "status": "running",
    "operation": "fs.setAccess",
    "createdAt": "2026-10-12T00:35:49.023Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/fbac35c0-2ef5-4ea6-85c1-f746e16bf433   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "fs.setAccess",
  "progress": "find /mnt/anas-ahr/rpahr -type d -exec /usr/bin/chmod g+s {} +",
  "result": {
    "pool": "rpahr",
    "mountpoint": "/mnt/anas-ahr/rpahr",
    "aclEnabled": true,
    "aclAutoEnabled": false,
    "namedCount": 1
  },
  "error": null
}

$ (sampler: progress lines of running jobs and argv of the acl/mode tools, distinct, first-seen order)
progress  fs.setAccess  setfacl -R -b -m u::rwX,g::r-X,o::r-X,u:rpuser:rwX,m::rwX /mnt/anas-ahr/rpahr
argv      /usr/bin/setfacl -R -b -m u::rwX,g::r-X,o::r-X,u:rpuser:rwX,m::rwX /mnt/anas-ahr/rpahr
argv      /usr/bin/setfacl -R -d --set u::rwx,g::r-x,o::r-x,u:rpuser:rwx,m::rwx /mnt/anas-ahr/rpahr
progress  fs.setAccess  setfacl -R -d --set u::rwx,g::r-x,o::r-x,u:rpuser:rwx,m::rwx /mnt/anas-ahr/rpahr

$ for p in $(zpool list -H -o name); do zpool history $p | wc -l | sed "s|^|$p |"; done | diff /root/rpproof/hist-before - && echo zpool history unchanged on every pool
zpool history unchanged on every pool

$ find /mnt/anas-ahr/rpahr -path "*/bulk/*" -prune -o -printf "%M %u:%g %p\n" | sort -k3
drwxrwsr-x root:root /mnt/anas-ahr/rpahr
drwxrwsr-x root:root /mnt/anas-ahr/rpahr/bulk
-rw-rw-r-- root:root /mnt/anas-ahr/rpahr/plain.txt
drwxrwsr-x root:root /mnt/anas-ahr/rpahr/sub1
-rw-rw-r-- root:root /mnt/anas-ahr/rpahr/sub1/insub.txt
-rwxrwxr-x root:root /mnt/anas-ahr/rpahr/tool.sh

$ find /mnt/anas-ahr/rpahr -type f -perm /2000 | wc -l; find /mnt/anas-ahr/rpahr -type d ! -perm -2000 | wc -l; find /mnt/anas-ahr/rpahr -type f -perm /111 -printf "%M %p\n"; find /mnt/anas-ahr/rpahr/bulk -type f ! -perm 0664 | wc -l
0
0
-rwxrwxr-x /mnt/anas-ahr/rpahr/tool.sh
0

$ getfacl -p /mnt/anas-ahr/rpahr/plain.txt /mnt/anas-ahr/rpahr/tool.sh /mnt/anas-ahr/rpahr/sub1/insub.txt
# file: /mnt/anas-ahr/rpahr/plain.txt
# owner: root
# group: root
user::rw-
user:rpuser:rw-
group::r--
mask::rw-
other::r--

# file: /mnt/anas-ahr/rpahr/tool.sh
# owner: root
# group: root
user::rwx
user:rpuser:rwx
group::r-x
mask::rwx
other::r-x

# file: /mnt/anas-ahr/rpahr/sub1/insub.txt
# owner: root
# group: root
user::rw-
user:rpuser:rw-
group::r--
mask::rw-
other::r--

$ getfacl -p /mnt/anas-ahr/rpahr /mnt/anas-ahr/rpahr/sub1
# file: /mnt/anas-ahr/rpahr
# owner: root
# group: root
# flags: -s-
user::rwx
user:rpuser:rwx
group::r-x
mask::rwx
other::r-x
default:user::rwx
default:user:rpuser:rwx
default:group::r-x
default:mask::rwx
default:other::r-x

# file: /mnt/anas-ahr/rpahr/sub1
# owner: root
# group: root
# flags: -s-
user::rwx
user:rpuser:rwx
group::r-x
mask::rwx
other::r-x
default:user::rwx
default:user:rpuser:rwx
default:group::r-x
default:mask::rwx
default:other::r-x

$ runuser -u rpuser -- /mnt/anas-ahr/rpahr/tool.sh
tool.sh ran as rpuser

$ runuser -u rpuser -- /mnt/anas-ahr/rpahr/plain.txt; echo exit=$?
runuser: failed to execute /mnt/anas-ahr/rpahr/plain.txt: Permission denied
exit=1

$ runuser -u rpuser -- sh -c "echo by-rpuser >> /mnt/anas-ahr/rpahr/sub1/insub.txt" && tail -1 /mnt/anas-ahr/rpahr/sub1/insub.txt
by-rpuser
```

## §5 — R3: two-user SMB write with `inherit acls`

**Pass criteria, stated before the run.** An SMB share `rp3` on a fresh dataset to `rpuser` (A) and
`rpuser2` (B), grant on, not recursive. A puts a file; B overwrites (and appends to) A's file; B
makes a directory and A writes a file into it. Pass: both writes succeed; `getfacl` on A's file
shows B's inherited entry with an effective mask that includes write; `testparm -s
--section-name=rp3` shows `inherit acls = Yes`. If B's write fails: record the file's `getfacl`
and mode and the share's effective `create mask`, as a finding, nothing fixed.

B's writes failed (R3), so R3x is a diagnosis on the same dataset with hand-written scratch
stanzas, removed at the end (smb.conf back to the same bytes, md5 shown), in the manner of the
previous document's §3x: no product file was changed. Each variant's stanza was appended to
smb.conf (path, `read only = no`, `valid users = rpuser rpuser2` and the three parameters named)
followed by `smbcontrol smbd reload-config`, by a helper the transcript does not echo;
the `testparm` output at the head of each variant shows the stanza as Samba read it.

```
### R3. an SMB share to two users, grant ON (not recursive); each user writes into what the other made

$ api POST /pools/testpool/datasets '{"path":"rp3"}'
HTTP 202
{
  "job": {
    "id": "784662c3-45f3-4f06-99e4-b63977d8ec90",
    "status": "running",
    "operation": "zfs.create",
    "createdAt": "2026-10-12T00:36:46.253Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/784662c3-45f3-4f06-99e4-b63977d8ec90   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "zfs.create",
  "progress": null,
  "result": {
    "created": "testpool/rp3"
  },
  "error": null
}

$ api POST /shares/smb '{"name":"rp3","path":"/testpool/rp3","comment":"","browseable":true,"readOnly":false,"guestOk":false,"validUsers":["rpuser","rpuser2"],"hostsAllow":[],"hostsDeny":[],"grantAccess":{}}'
HTTP 202
{
  "job": {
    "id": "83b70273-0242-49e1-bb36-c2c4b6a753cd",
    "status": "running",
    "operation": "smb.share.add",
    "createdAt": "2026-10-12T00:36:46.505Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/83b70273-0242-49e1-bb36-c2c4b6a753cd   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.share.add",
  "progress": "chmod g+s /testpool/rp3",
  "result": {
    "created": "rp3",
    "grant": {
      "status": "applied",
      "path": "/testpool/rp3",
      "granted": [
        {
          "kind": "user",
          "name": "rpuser",
          "level": "read-write"
        },
        {
          "kind": "user",
          "name": "rpuser2",
          "level": "read-write"
        }
      ],
      "skipped": [],
      "applyToExisting": false
    }
  },
  "error": null
}

$ testparm -s --section-name=rp3 2>/dev/null

[rp3]
	inherit acls = Yes
	path = /testpool/rp3
	read only = No
	valid users = rpuser rpuser2

$ for p in "inherit acls" "create mask" "directory mask" "inherit permissions"; do printf "%s = " "$p"; testparm -s --section-name=rp3 --parameter-name="$p" 2>/dev/null; done
inherit acls = Yes
create mask = 0744
directory mask = 0755
inherit permissions = No

$ zfs get -H -o property,value,source acltype,xattr testpool/rp3; getfacl -p /testpool/rp3
acltype	posix	local
xattr	sa	local
# file: /testpool/rp3
# owner: root
# group: root
# flags: -s-
user::rwx
user:rpuser:rwx
user:rpuser2:rwx
group::r-x
mask::rwx
other::r-x
default:user::rwx
default:user:rpuser:rwx
default:user:rpuser2:rwx
default:group::r-x
default:mask::rwx
default:other::r-x

--- A (rpuser) puts a file; B (rpuser2) overwrites it, then appends to it with reput

$ echo "written by rpuser over SMB" > /root/rpproof/a.txt; echo "rpuser2 overwrote this over SMB, and this line is longer" > /root/rpproof/b.txt; cp /root/rpproof/b.txt /root/rpproof/b2.txt; echo "rpuser2 appended this line" >> /root/rpproof/b2.txt

$ smbclient //localhost/rp3 -U "rpuser%Rp-proof-1" -c "put /root/rpproof/a.txt a.txt" 2>&1 | grep -v "^putting"; stat -c "%A %U:%G %n" /testpool/rp3/a.txt; getfacl -p /testpool/rp3/a.txt
-rwxr--r-- rpuser:root /testpool/rp3/a.txt
# file: /testpool/rp3/a.txt
# owner: rpuser
# group: root
user::rwx
user:rpuser:rwx	#effective:r--
user:rpuser2:rwx	#effective:r--
group::r-x	#effective:r--
mask::r--
other::r--

$ smbclient //localhost/rp3 -U "rpuser2%Rp-proof-2" -c "put /root/rpproof/b.txt a.txt" 2>&1; cat /testpool/rp3/a.txt
NT_STATUS_ACCESS_DENIED opening remote file \a.txt
written by rpuser over SMB

$ smbclient //localhost/rp3 -U "rpuser2%Rp-proof-2" -c "reput /root/rpproof/b2.txt a.txt" 2>&1; cat /testpool/rp3/a.txt; stat -c "%A %U:%G %n" /testpool/rp3/a.txt
NT_STATUS_ACCESS_DENIED opening remote file \a.txt
written by rpuser over SMB
-rwxr--r-- rpuser:root /testpool/rp3/a.txt

--- B makes a directory; A writes into it

$ smbclient //localhost/rp3 -U "rpuser2%Rp-proof-2" -c "mkdir bdir" 2>&1; stat -c "%A %U:%G %n" /testpool/rp3/bdir; getfacl -p /testpool/rp3/bdir
drwxr-sr-x rpuser2:root /testpool/rp3/bdir
# file: /testpool/rp3/bdir
# owner: rpuser2
# group: root
# flags: -s-
user::rwx
user:rpuser:rwx	#effective:r-x
user:rpuser2:rwx	#effective:r-x
group::r-x
mask::r-x
other::r-x
default:user::rwx
default:user:rpuser:rwx
default:user:rpuser2:rwx
default:group::r-x
default:mask::rwx
default:other::r-x

$ smbclient //localhost/rp3 -U "rpuser%Rp-proof-1" -c "cd bdir; put /root/rpproof/a.txt from-a.txt; ls" 2>&1 | grep -v "^putting\|blocks of size"; stat -c "%A %U:%G %n" /testpool/rp3/bdir/from-a.txt; getfacl -p /testpool/rp3/bdir/from-a.txt
NT_STATUS_ACCESS_DENIED opening remote file \bdir\from-a.txt
  .                                   D        0  Mon Oct 12 00:36:47 2026
  ..                                  D        0  Mon Oct 12 00:36:47 2026

stat: cannot statx '/testpool/rp3/bdir/from-a.txt': No such file or directory
getfacl: /testpool/rp3/bdir/from-a.txt: No such file or directory

$ smbclient //localhost/rp3 -U "rpuser2%Rp-proof-2" -c "cd bdir; put /root/rpproof/b.txt from-a.txt" 2>&1 | grep -v "^putting"; cat /testpool/rp3/bdir/from-a.txt
rpuser2 overwrote this over SMB, and this line is longer
```

```
### R3x. diagnosis (a hand-written scratch stanza on a directory inside rp3, removed at the end; no product path): which parameter decides what an SMB-created file gives the other user

$ cp -p /etc/samba/smb.conf /root/rpproof/smb.conf.pre-r3x && md5sum /etc/samba/smb.conf
8ca7ef1bfb54446be077fb7577a353b9  /etc/samba/smb.conf

$ mkdir /testpool/rp3/diag1 /testpool/rp3/diag2 /testpool/rp3/diag3 && getfacl -p /testpool/rp3/diag1 | grep -E "^default:|^mask"
mask::rwx
default:user::rwx
default:user:rpuser:rwx
default:user:rpuser2:rwx
default:group::r-x
default:mask::rwx
default:other::r-x

--- stanza [rpdiag1]

$ testparm -s --section-name=rpdiag1 2>/dev/null | tail -n +2; for p in "inherit acls" "create mask" "directory mask"; do printf "%s = " "$p"; testparm -s --section-name=rpdiag1 --parameter-name="$p" 2>/dev/null; done
[rpdiag1]
	create mask = 0666
	directory mask = 0777
	inherit acls = Yes
	path = /testpool/rp3/diag1
	read only = No
	valid users = rpuser rpuser2
inherit acls = Yes
create mask = 0666
directory mask = 0777

$ smbclient //localhost/rpdiag1 -U rpuser%Rp-proof-1 -c "put /root/rpproof/a.txt a.txt" 2>&1 | grep -v ^putting; stat -c "%A %U:%G %n" /testpool/rp3/diag1/a.txt; getfacl -p /testpool/rp3/diag1/a.txt | grep -E "^user:rpuser2|^mask"
-rw-rw-r-- rpuser:root /testpool/rp3/diag1/a.txt
user:rpuser2:rwx	#effective:rw-
mask::rw-

$ smbclient //localhost/rpdiag1 -U rpuser2%Rp-proof-2 -c "put /root/rpproof/b.txt a.txt" 2>&1 | grep -v ^putting; cat /testpool/rp3/diag1/a.txt
rpuser2 overwrote this over SMB, and this line is longer

$ smbclient //localhost/rpdiag1 -U rpuser2%Rp-proof-2 -c "mkdir bdir" 2>&1; stat -c "%A %U:%G %n" /testpool/rp3/diag1/bdir; getfacl -p /testpool/rp3/diag1/bdir | grep -E "^user:rpuser:|^mask"
drwxrwsr-x rpuser2:root /testpool/rp3/diag1/bdir
user:rpuser:rwx
mask::rwx

$ smbclient //localhost/rpdiag1 -U rpuser%Rp-proof-1 -c "cd bdir; put /root/rpproof/a.txt from-a.txt" 2>&1 | grep -v ^putting; stat -c "%A %U:%G %n" /testpool/rp3/diag1/bdir/from-a.txt
-rw-rw-r-- rpuser:root /testpool/rp3/diag1/bdir/from-a.txt

--- stanza [rpdiag2]

$ testparm -s --section-name=rpdiag2 2>/dev/null | tail -n +2; for p in "inherit acls" "create mask" "directory mask"; do printf "%s = " "$p"; testparm -s --section-name=rpdiag2 --parameter-name="$p" 2>/dev/null; done
[rpdiag2]
	create mask = 0666
	directory mask = 0777
	path = /testpool/rp3/diag2
	read only = No
	valid users = rpuser rpuser2
inherit acls = No
create mask = 0666
directory mask = 0777

$ smbclient //localhost/rpdiag2 -U rpuser%Rp-proof-1 -c "put /root/rpproof/a.txt a.txt" 2>&1 | grep -v ^putting; stat -c "%A %U:%G %n" /testpool/rp3/diag2/a.txt; getfacl -p /testpool/rp3/diag2/a.txt | grep -E "^user:rpuser2|^mask"
-rw-rw-r-- rpuser:root /testpool/rp3/diag2/a.txt
user:rpuser2:rwx	#effective:rw-
mask::rw-

$ smbclient //localhost/rpdiag2 -U rpuser2%Rp-proof-2 -c "put /root/rpproof/b.txt a.txt" 2>&1 | grep -v ^putting; cat /testpool/rp3/diag2/a.txt
rpuser2 overwrote this over SMB, and this line is longer

$ smbclient //localhost/rpdiag2 -U rpuser2%Rp-proof-2 -c "mkdir bdir" 2>&1; stat -c "%A %U:%G %n" /testpool/rp3/diag2/bdir; getfacl -p /testpool/rp3/diag2/bdir | grep -E "^user:rpuser:|^mask"
drwxrwsr-x rpuser2:root /testpool/rp3/diag2/bdir
user:rpuser:rwx
mask::rwx

$ smbclient //localhost/rpdiag2 -U rpuser%Rp-proof-1 -c "cd bdir; put /root/rpproof/a.txt from-a.txt" 2>&1 | grep -v ^putting; stat -c "%A %U:%G %n" /testpool/rp3/diag2/bdir/from-a.txt
-rw-rw-r-- rpuser:root /testpool/rp3/diag2/bdir/from-a.txt

--- stanza [rpdiag3]

$ testparm -s --section-name=rpdiag3 2>/dev/null | tail -n +2; for p in "inherit acls" "create mask" "directory mask"; do printf "%s = " "$p"; testparm -s --section-name=rpdiag3 --parameter-name="$p" 2>/dev/null; done
[rpdiag3]
	create mask = 0777
	directory mask = 0777
	inherit acls = Yes
	path = /testpool/rp3/diag3
	read only = No
	valid users = rpuser rpuser2
inherit acls = Yes
create mask = 0777
directory mask = 0777

$ smbclient //localhost/rpdiag3 -U rpuser%Rp-proof-1 -c "put /root/rpproof/a.txt a.txt" 2>&1 | grep -v ^putting; stat -c "%A %U:%G %n" /testpool/rp3/diag3/a.txt; getfacl -p /testpool/rp3/diag3/a.txt | grep -E "^user:rpuser2|^mask"
-rwxrwxr-x rpuser:root /testpool/rp3/diag3/a.txt
user:rpuser2:rwx
mask::rwx

$ smbclient //localhost/rpdiag3 -U rpuser2%Rp-proof-2 -c "put /root/rpproof/b.txt a.txt" 2>&1 | grep -v ^putting; cat /testpool/rp3/diag3/a.txt
rpuser2 overwrote this over SMB, and this line is longer

$ smbclient //localhost/rpdiag3 -U rpuser2%Rp-proof-2 -c "mkdir bdir" 2>&1; stat -c "%A %U:%G %n" /testpool/rp3/diag3/bdir; getfacl -p /testpool/rp3/diag3/bdir | grep -E "^user:rpuser:|^mask"
drwxrwsr-x rpuser2:root /testpool/rp3/diag3/bdir
user:rpuser:rwx
mask::rwx

$ smbclient //localhost/rpdiag3 -U rpuser%Rp-proof-1 -c "cd bdir; put /root/rpproof/a.txt from-a.txt" 2>&1 | grep -v ^putting; stat -c "%A %U:%G %n" /testpool/rp3/diag3/bdir/from-a.txt
-rwxrwxr-x rpuser:root /testpool/rp3/diag3/bdir/from-a.txt

--- scratch stanzas removed: smb.conf back to its bytes before R3x

$ cp -p /root/rpproof/smb.conf.pre-r3x /etc/samba/smb.conf && smbcontrol smbd reload-config && md5sum /etc/samba/smb.conf && grep -c "^\[rpdiag" /etc/samba/smb.conf
8ca7ef1bfb54446be077fb7577a353b9  /etc/samba/smb.conf
0
```

## §6 — R4: pre-existing stanzas

**Pass criteria, stated before the run.** Two stanzas written by hand into the daemon's own config
path (`/etc/samba/smb.conf`, the path `server.ts` gives the share routes), in the shape 0.4.2's
`renderStanza` wrote (path, comment, browseable, read only, guest ok, valid users; tab indent):
`rp4` without `inherit acls`, and `rp4n` with an explicit `inherit acls = no`. (a) An edit with no
grant leaves the stanza byte-identical: resending the stanza's own values leaves the whole file
byte-identical (`cmp`), and a comment change differs in that one line only. (b) An edit that grants
(valid users changed, `grantAccess` present) adds `inherit acls = yes` once and changes nothing else
in the stanza (no line moved); a second granting edit does not add it again. (c) The `inherit acls
= no` stanza edited with a grant keeps `inherit acls = no`.

```
### R4. stanzas written as 0.4.2 wrote them (no inherit acls), then edited through the API

$ api POST /pools/testpool/datasets '{"path":"rp4"}'
HTTP 202
{
  "job": {
    "id": "53a8981b-a835-42c1-b82c-26dab3238d76",
    "status": "running",
    "operation": "zfs.create",
    "createdAt": "2026-10-12T00:38:43.139Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/53a8981b-a835-42c1-b82c-26dab3238d76   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "zfs.create",
  "progress": null,
  "result": {
    "created": "testpool/rp4"
  },
  "error": null
}

$ mkdir /testpool/rp4/n && tail -c1 /etc/samba/smb.conf | od -An -c && printf "\n[rp4]\n\tpath = /testpool/rp4\n\tcomment = pre-existing\n\tbrowseable = yes\n\tread only = no\n\tguest ok = no\n\tvalid users = rpuser\n\n[rp4n]\n\tpath = /testpool/rp4/n\n\tbrowseable = yes\n\tread only = no\n\tguest ok = no\n\tinherit acls = no\n\tvalid users = rpuser\n" >> /etc/samba/smb.conf && smbcontrol smbd reload-config && testparm -s 2>&1 >/dev/null | grep -ciE "error|unknown"
  \n
0

$ st rp4 | cat -A; st rp4n | cat -A
[rp4]$
^Ipath = /testpool/rp4$
^Icomment = pre-existing$
^Ibrowseable = yes$
^Iread only = no$
^Iguest ok = no$
^Ivalid users = rpuser$
$
[rp4n]$
^Ipath = /testpool/rp4/n$
^Ibrowseable = yes$
^Iread only = no$
^Iguest ok = no$
^Iinherit acls = no$
^Ivalid users = rpuser$

$ api GET /shares/smb/rp4
HTTP 200
{
  "data": {
    "name": "rp4",
    "path": "/testpool/rp4",
    "comment": "pre-existing",
    "browseable": true,
    "readOnly": false,
    "guestOk": false,
    "validUsers": [
      "rpuser"
    ],
    "hostsAllow": [],
    "hostsDeny": [],
    "pathExists": true,
    "connections": [],
    "capacity": {
      "availableBytes": 1875876864
    }
  }
}

--- R4a-1. an edit with no grant that resends the stanza as it is

$ cp /etc/samba/smb.conf /root/rpproof/c0

$ api PUT /shares/smb/rp4 '{"path":"/testpool/rp4","comment":"pre-existing","browseable":true,"readOnly":false,"guestOk":false,"validUsers":["rpuser"],"hostsAllow":[],"hostsDeny":[]}'
HTTP 202
{
  "job": {
    "id": "cbd9c2a1-66b0-4304-9ed7-6cf0f8ae96f1",
    "status": "running",
    "operation": "smb.config.set",
    "createdAt": "2026-10-12T00:38:43.904Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/cbd9c2a1-66b0-4304-9ed7-6cf0f8ae96f1   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.config.set",
  "progress": null,
  "result": {
    "updated": "rp4"
  },
  "error": null
}

$ cmp /root/rpproof/c0 /etc/samba/smb.conf && echo smb.conf byte-identical
smb.conf byte-identical

--- R4a-2. an edit with no grant that changes the comment

$ api PUT /shares/smb/rp4 '{"path":"/testpool/rp4","comment":"pre-existing, edited","browseable":true,"readOnly":false,"guestOk":false,"validUsers":["rpuser"],"hostsAllow":[],"hostsDeny":[]}'
HTTP 202
{
  "job": {
    "id": "7ec8284f-51a2-47fd-9c8a-d85494471f7e",
    "status": "running",
    "operation": "smb.config.set",
    "createdAt": "2026-10-12T00:38:44.400Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/7ec8284f-51a2-47fd-9c8a-d85494471f7e   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.config.set",
  "progress": null,
  "result": {
    "updated": "rp4"
  },
  "error": null
}

$ diff /root/rpproof/c0 /etc/samba/smb.conf; st rp4 | cat -A
294c294
< 	comment = pre-existing
---
> 	comment = pre-existing, edited
[rp4]$
^Ipath = /testpool/rp4$
^Icomment = pre-existing, edited$
^Ibrowseable = yes$
^Iread only = no$
^Iguest ok = no$
^Ivalid users = rpuser$
$

--- R4b. an edit that grants (valid users changed, grantAccess present)

$ cp /etc/samba/smb.conf /root/rpproof/c1

$ api PUT /shares/smb/rp4 '{"path":"/testpool/rp4","comment":"pre-existing, edited","browseable":true,"readOnly":false,"guestOk":false,"validUsers":["rpuser","rpuser2"],"hostsAllow":[],"hostsDeny":[],"grantAccess":{}}'
HTTP 202
{
  "job": {
    "id": "109a7f86-8f34-4bad-80ed-f5f799dde8cf",
    "status": "running",
    "operation": "smb.config.set",
    "createdAt": "2026-10-12T00:38:44.891Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/109a7f86-8f34-4bad-80ed-f5f799dde8cf   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.config.set",
  "progress": "chmod g+s /testpool/rp4",
  "result": {
    "updated": "rp4",
    "grant": {
      "status": "applied",
      "path": "/testpool/rp4",
      "granted": [
        {
          "kind": "user",
          "name": "rpuser",
          "level": "read-write"
        },
        {
          "kind": "user",
          "name": "rpuser2",
          "level": "read-write"
        }
      ],
      "skipped": [],
      "applyToExisting": false
    }
  },
  "error": null
}

$ diff /root/rpproof/c1 /etc/samba/smb.conf; st rp4 | cat -A
298c298,299
< 	valid users = rpuser
---
> 	valid users = rpuser rpuser2
> 	inherit acls = yes
[rp4]$
^Ipath = /testpool/rp4$
^Icomment = pre-existing, edited$
^Ibrowseable = yes$
^Iread only = no$
^Iguest ok = no$
^Ivalid users = rpuser rpuser2$
^Iinherit acls = yes$
$

--- R4b-2. a second granting edit on the same stanza: the line is not added twice

$ cp /etc/samba/smb.conf /root/rpproof/c2

$ api PUT /shares/smb/rp4 '{"path":"/testpool/rp4","comment":"pre-existing, edited","browseable":true,"readOnly":false,"guestOk":false,"validUsers":["rpuser"],"hostsAllow":[],"hostsDeny":[],"grantAccess":{}}'
HTTP 202
{
  "job": {
    "id": "a01b0b68-deff-4a6b-80a6-995ca19d5fd7",
    "status": "running",
    "operation": "smb.config.set",
    "createdAt": "2026-10-12T00:38:45.270Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/a01b0b68-deff-4a6b-80a6-995ca19d5fd7   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.config.set",
  "progress": "chmod g+s /testpool/rp4",
  "result": {
    "updated": "rp4",
    "grant": {
      "status": "applied",
      "path": "/testpool/rp4",
      "granted": [
        {
          "kind": "user",
          "name": "rpuser",
          "level": "read-write"
        }
      ],
      "skipped": [],
      "applyToExisting": false
    }
  },
  "error": null
}

$ diff /root/rpproof/c2 /etc/samba/smb.conf; st rp4 | grep -c "inherit acls"
298c298
< 	valid users = rpuser rpuser2
---
> 	valid users = rpuser
1

--- R4c. a stanza that says inherit acls = no, edited with a grant

$ cp /etc/samba/smb.conf /root/rpproof/c3

$ api PUT /shares/smb/rp4n '{"path":"/testpool/rp4/n","comment":"","browseable":true,"readOnly":false,"guestOk":false,"validUsers":["rpuser","rpuser2"],"hostsAllow":[],"hostsDeny":[],"grantAccess":{}}'
HTTP 202
{
  "job": {
    "id": "89797a67-6bad-4833-98b8-da1891b5c548",
    "status": "running",
    "operation": "smb.config.set",
    "createdAt": "2026-10-12T00:38:45.738Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/89797a67-6bad-4833-98b8-da1891b5c548   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.config.set",
  "progress": "chmod g+s /testpool/rp4/n",
  "result": {
    "updated": "rp4n",
    "grant": {
      "status": "applied",
      "path": "/testpool/rp4/n",
      "granted": [
        {
          "kind": "user",
          "name": "rpuser",
          "level": "read-write"
        },
        {
          "kind": "user",
          "name": "rpuser2",
          "level": "read-write"
        }
      ],
      "skipped": [],
      "applyToExisting": false
    }
  },
  "error": null
}

$ diff /root/rpproof/c3 /etc/samba/smb.conf; st rp4n | cat -A; testparm -s --section-name=rp4n --parameter-name="inherit acls" 2>/dev/null
307c307
< 	valid users = rpuser
---
> 	valid users = rpuser rpuser2
[rp4n]$
^Ipath = /testpool/rp4/n$
^Ibrowseable = yes$
^Iread only = no$
^Iguest ok = no$
^Iinherit acls = no$
^Ivalid users = rpuser rpuser2$
No
```

## §7 — R5: share door ordering (previous §6c)

**Pass criteria, stated before the run.** `POST /shares/smb` with `grantAccess.applyToExisting` on
`/srv/rpproof` (ext4, not ZFS) with a throwaway `dir` storage `rpstore` at `/srv/rpproof/store`
answers 202 with no 409 and no `X-Anas-Confirm-Code`; the share is created; the job's
`grant.status` is `"refused"` with the gate's sentence; the path's ACL is unchanged. Then the editor
door `PUT /shares/smb/rp5/access` with `applyToExisting` on the same path answers 400. Added: the
share door's edit (`PUT /shares/smb/rp5` with a recursive grant) takes the same order.

```
### R5. share create with a recursive grant on a non-ZFS directory holding a dir storage (throwaway storage rpstore)

$ mkdir -p /srv/rpproof/store && echo old > /srv/rpproof/old.txt && pvesm add dir rpstore --path /srv/rpproof/store --content backup && grep -A2 "^dir: rpstore" /etc/pve/storage.cfg; findmnt -n -o FSTYPE -T /srv/rpproof
dir: rpstore
	path /srv/rpproof/store
	content backup
ext4

$ getfacl -p /srv/rpproof /srv/rpproof/old.txt
# file: /srv/rpproof
# owner: root
# group: root
user::rwx
group::r-x
other::r-x

# file: /srv/rpproof/old.txt
# owner: root
# group: root
user::rw-
group::r--
other::r--

$ api POST /shares/smb '{"name":"rp5","path":"/srv/rpproof","comment":"","browseable":true,"readOnly":false,"guestOk":false,"validUsers":["rpuser"],"hostsAllow":[],"hostsDeny":[],"grantAccess":{"applyToExisting":true}}'
HTTP 202
{
  "job": {
    "id": "eb320ae2-d83c-49be-a5cc-48d080cd1a0f",
    "status": "running",
    "operation": "smb.share.add",
    "createdAt": "2026-10-12T00:39:14.104Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/eb320ae2-d83c-49be-a5cc-48d080cd1a0f   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.share.add",
  "progress": null,
  "result": {
    "created": "rp5",
    "grant": {
      "status": "refused",
      "path": "/srv/rpproof",
      "granted": [],
      "skipped": [],
      "applyToExisting": true,
      "message": "Recursive permission change of '/srv/rpproof' would include /srv/rpproof/store — the path of PVE storage 'rpstore'"
    }
  },
  "error": null
}

$ testparm -s --section-name=rp5 2>/dev/null; getfacl -p /srv/rpproof /srv/rpproof/old.txt

[rp5]
	inherit acls = Yes
	path = /srv/rpproof
	read only = No
	valid users = rpuser
# file: /srv/rpproof
# owner: root
# group: root
user::rwx
group::r-x
other::r-x

# file: /srv/rpproof/old.txt
# owner: root
# group: root
user::rw-
group::r--
other::r--

--- the editor door on the same path, recursive

$ api PUT /shares/smb/rp5/access '{"owner":"root","group":"root","entries":[{"kind":"owner","level":"read-write"},{"kind":"owning-group","level":"read"},{"kind":"everyone","level":"read"},{"kind":"user","name":"rpuser","level":"read-write"}],"applyToExisting":true}'
HTTP 400
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Recursive permission change of '/srv/rpproof' would include /srv/rpproof/store — the path of PVE storage 'rpstore'"
  }
}

--- the share door edit with a recursive grant on the same share (the edit path of the same ordering)

$ api PUT /shares/smb/rp5 '{"path":"/srv/rpproof","comment":"","browseable":true,"readOnly":false,"guestOk":false,"validUsers":["rpuser","rpuser2"],"hostsAllow":[],"hostsDeny":[],"grantAccess":{"applyToExisting":true}}'
HTTP 202
{
  "job": {
    "id": "b5f7bc26-ebd0-4555-bfef-68c3975b0e24",
    "status": "running",
    "operation": "smb.config.set",
    "createdAt": "2026-10-12T00:39:14.886Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/b5f7bc26-ebd0-4555-bfef-68c3975b0e24   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.config.set",
  "progress": null,
  "result": {
    "updated": "rp5",
    "grant": {
      "status": "refused",
      "path": "/srv/rpproof",
      "granted": [],
      "skipped": [],
      "applyToExisting": true,
      "message": "Recursive permission change of '/srv/rpproof' would include /srv/rpproof/store — the path of PVE storage 'rpstore'"
    }
  },
  "error": null
}

$ getfacl -p /srv/rpproof /srv/rpproof/old.txt | grep -cE "^user:[a-z]|^default:"
0
```

## §8 — R6: the grant result reports the level kept

**Pass criteria, stated before the run.** The R3 share `rp3` (both users read-write on the path)
edited to read-only with `grantAccess`: the job's `grant.granted` reports `read-write` for each user
(the level kept by the never-lower rule, not the `read` the share asks for), and the path's ACL
still shows `rwx` for both.

```
### R6. the R3 share (both users read-write) edited to read-only with the grant on

$ getfacl -p /testpool/rp3 | grep -E "^user:|^mask"
user::rwx
user:rpuser:rwx
user:rpuser2:rwx
mask::rwx

$ api GET /shares/smb/rp3/access
HTTP 200
{
  "data": {
    "owner": "root",
    "group": "root",
    "aclSupported": true,
    "aclEnabled": true,
    "entries": [
      {
        "kind": "owner",
        "level": "read-write"
      },
      {
        "kind": "owning-group",
        "level": "read"
      },
      {
        "kind": "everyone",
        "level": "read"
      },
      {
        "kind": "user",
        "name": "rpuser",
        "level": "read-write"
      },
      {
        "kind": "user",
        "name": "rpuser2",
        "level": "read-write"
      }
    ],
    "aclText": "# file: /testpool/rp3\n# owner: root\n# group: root\n# flags: -s-\nuser::rwx\nuser:rpuser:rwx\nuser:rpuser2:rwx\ngroup::r-x\nmask::rwx\nother::r-x\ndefault:user::rwx\ndefault:user:rpuser:rwx\ndefault:user:rpuser2:rwx\ndefault:group::r-x\ndefault:mask::rwx\ndefault:other::r-x\n\n",
    "backing": "zfs"
  }
}

$ api PUT /shares/smb/rp3 '{"path":"/testpool/rp3","comment":"","browseable":true,"readOnly":true,"guestOk":false,"validUsers":["rpuser","rpuser2"],"hostsAllow":[],"hostsDeny":[],"grantAccess":{}}'
HTTP 202
{
  "job": {
    "id": "df331a01-bda8-4be9-8d10-2c40398dd76f",
    "status": "running",
    "operation": "smb.config.set",
    "createdAt": "2026-10-12T00:39:35.490Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/df331a01-bda8-4be9-8d10-2c40398dd76f   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.config.set",
  "progress": "chmod g+s /testpool/rp3",
  "result": {
    "updated": "rp3",
    "grant": {
      "status": "applied",
      "path": "/testpool/rp3",
      "granted": [
        {
          "kind": "user",
          "name": "rpuser",
          "level": "read-write"
        },
        {
          "kind": "user",
          "name": "rpuser2",
          "level": "read-write"
        }
      ],
      "skipped": [],
      "applyToExisting": false
    }
  },
  "error": null
}

$ testparm -s --section-name=rp3 2>/dev/null; getfacl -p /testpool/rp3

[rp3]
	inherit acls = Yes
	path = /testpool/rp3
	valid users = rpuser rpuser2
# file: /testpool/rp3
# owner: root
# group: root
# flags: -s-
user::rwx
user:rpuser:rwx
user:rpuser2:rwx
group::r-x
mask::rwx
other::r-x
default:user::rwx
default:user:rpuser:rwx
default:user:rpuser2:rwx
default:group::r-x
default:mask::rwx
default:other::r-x

$ api GET /shares/smb/rp3/access
HTTP 200
{
  "data": {
    "owner": "root",
    "group": "root",
    "aclSupported": true,
    "aclEnabled": true,
    "entries": [
      {
        "kind": "owner",
        "level": "read-write"
      },
      {
        "kind": "owning-group",
        "level": "read"
      },
      {
        "kind": "everyone",
        "level": "read"
      },
      {
        "kind": "user",
        "name": "rpuser",
        "level": "read-write"
      },
      {
        "kind": "user",
        "name": "rpuser2",
        "level": "read-write"
      }
    ],
    "aclText": "# file: /testpool/rp3\n# owner: root\n# group: root\n# flags: -s-\nuser::rwx\nuser:rpuser:rwx\nuser:rpuser2:rwx\ngroup::r-x\nmask::rwx\nother::r-x\ndefault:user::rwx\ndefault:user:rpuser:rwx\ndefault:user:rpuser2:rwx\ndefault:group::r-x\ndefault:mask::rwx\ndefault:other::r-x\n\n",
    "backing": "zfs"
  }
}
```

## §9 — R7: the repair command

**Pass criteria, stated before the run.** A tree damaged the old way by hand (`chmod -R a+x,g+s`),
then the release-notes command `find <dir> -type f -exec chmod a-x,g-s {} +`: every regular file
loses execute and setgid; every directory keeps setgid and execute. The tree is the R1 dataset
(20,007 files, five directories, the child dataset `kid` mounted inside), so the command's
"including datasets mounted inside it" is exercised too. R7b repeats it on one file damaged exactly
as the old writer did (its `setfacl --set` spec with literal `x`, then `chmod g+s`), because a hand
`chmod a+x` on an ACL'd file moves the mask and leaves the named entry as it was, while the old
writer wrote the named entry itself as `rwx`.

```
### R7. the R1 tree damaged the old way by hand, then the release-notes repair command

$ chmod -R a+x,g+s /testpool/rp1

$ find /testpool/rp1 -type f | wc -l; find /testpool/rp1 -type f ! -perm -2111 | wc -l; find /testpool/rp1 -type d | wc -l; find /testpool/rp1 -type d ! -perm -2111 | wc -l
20007
0
5
0

$ find /testpool/rp1 -path "*/bulk/*" -prune -o -printf "%M %p\n" | sort -k2; stat -c "%A %n" /testpool/rp1/bulk/f00001
drwxrwsr-x /testpool/rp1
drwxrwsr-x /testpool/rp1/bulk
drwxrwsr-x /testpool/rp1/kid
-rwxrwsr-x /testpool/rp1/kid/kid.txt
-rwxrwsr-x /testpool/rp1/owner-x.txt
-rwxrwsr-x /testpool/rp1/plain.txt
-rwxrwsr-x /testpool/rp1/private.txt
-rwxrwsr-x /testpool/rp1/run.sh
drwxrwsr-x /testpool/rp1/sub
-rwxrwsr-x /testpool/rp1/sub/by-rpuser.txt
-rwxrwsr-x /testpool/rp1/sub/inner.txt
drwxrwsr-x /testpool/rp1/sub/rpdir
-rwxrwsr-x /testpool/rp1/bulk/f00001

$ getfacl -p /testpool/rp1/plain.txt
# file: /testpool/rp1/plain.txt
# owner: root
# group: root
# flags: -s-
user::rwx
user:rpuser:rw-
group::r--
mask::rwx
other::r-x

--- the repair command, exactly as the release notes give it

$ find /testpool/rp1 -type f -exec chmod a-x,g-s {} +; echo exit=$?
exit=0

$ find /testpool/rp1 -type f -perm /2111 | wc -l; find /testpool/rp1 -type d ! -perm -2111 | wc -l
0
0

$ find /testpool/rp1 -path "*/bulk/*" -prune -o -printf "%M %p\n" | sort -k2; stat -c "%A %n" /testpool/rp1/bulk/f00001
drwxrwsr-x /testpool/rp1
drwxrwsr-x /testpool/rp1/bulk
drwxrwsr-x /testpool/rp1/kid
-rw-rw-r-- /testpool/rp1/kid/kid.txt
-rw-rw-r-- /testpool/rp1/owner-x.txt
-rw-rw-r-- /testpool/rp1/plain.txt
-rw-rw-r-- /testpool/rp1/private.txt
-rw-rw-r-- /testpool/rp1/run.sh
drwxrwsr-x /testpool/rp1/sub
-rw-rw-r-- /testpool/rp1/sub/by-rpuser.txt
-rw-rw-r-- /testpool/rp1/sub/inner.txt
drwxrwsr-x /testpool/rp1/sub/rpdir
-rw-rw-r-- /testpool/rp1/bulk/f00001

$ getfacl -p /testpool/rp1/plain.txt /testpool/rp1/kid/kid.txt /testpool/rp1/kid
# file: /testpool/rp1/plain.txt
# owner: root
# group: root
user::rw-
user:rpuser:rw-
group::r--
mask::rw-
other::r--

# file: /testpool/rp1/kid/kid.txt
# owner: root
# group: root
user::rw-
user:rpuser:rw-
group::r--
mask::rw-
other::r--

# file: /testpool/rp1/kid
# owner: root
# group: root
# flags: -s-
user::rwx
user:rpuser:rwx
group::r-x
mask::rwx
other::r-x
default:user::rwx
default:user:rpuser:rwx
default:group::r-x
default:mask::rwx
default:other::r-x

$ runuser -u rpuser -- sh -c "echo after-repair >> /testpool/rp1/plain.txt" && tail -1 /testpool/rp1/plain.txt
after-repair
```

```
### R7b. the exact 0.4.2 damage on one scratch file (the spec and chmod the old writer ran, previous §3), then the repair

$ mkdir /testpool/rp1/r7b && echo data > /testpool/rp1/r7b/old.txt && setfacl --set "u::rwx,g::r-x,o::r-x,u:rpuser:rwx,m::rwx" /testpool/rp1/r7b/old.txt && chmod g+s /testpool/rp1/r7b/old.txt && stat -c "%A %n" /testpool/rp1/r7b/old.txt && getfacl -p /testpool/rp1/r7b/old.txt
-rwxrwsr-x /testpool/rp1/r7b/old.txt
# file: /testpool/rp1/r7b/old.txt
# owner: root
# group: root
# flags: -s-
user::rwx
user:rpuser:rwx
group::r-x
mask::rwx
other::r-x

$ find /testpool/rp1/r7b -type f -exec chmod a-x,g-s {} +; stat -c "%A %n" /testpool/rp1/r7b /testpool/rp1/r7b/old.txt; getfacl -p /testpool/rp1/r7b/old.txt
drwxrwsr-x /testpool/rp1/r7b
-rw-rw-r-- /testpool/rp1/r7b/old.txt
# file: /testpool/rp1/r7b/old.txt
# owner: root
# group: root
user::rw-
user:rpuser:rwx	#effective:rw-
group::r-x	#effective:r--
mask::rw-
other::r--

$ runuser -u rpuser -- sh -c "echo rpuser-writes >> /testpool/rp1/r7b/old.txt" && cat /testpool/rp1/r7b/old.txt; runuser -u rpuser -- /testpool/rp1/r7b/old.txt; echo exit=$?
data
rpuser-writes
runuser: failed to execute /testpool/rp1/r7b/old.txt: Permission denied
exit=1
```

## §10 — R8: teardown and node health

**Pass criteria, stated before the run.** As the previous document's §8: every share, user,
dataset, pool, storage and scratch file this proof made is gone; the fixture disks are detached;
`anasd anas smbd` active with NRestarts 0; `/v1/health` ok on the socket and through the front door;
no warning-or-worse line from anasd or the gateway since the deploy; testparm clean; the node runs
the build under test.

The first run below removed nothing ANAS manages: each resend passed the confirm code in the body
slot of `api` (`api DELETE <path> <code>` instead of `api DELETE <path> '' <code>`), and pveproxy
answered 501 to a DELETE with a body. Its two shell steps (`pvesm remove rpstore`, `rm -rf
/srv/rpproof`) did run. The second run is the teardown.

```
### R8. teardown, through the API where ANAS made or manages it; shell only for the shell-made fixtures

$ api DELETE /shares/smb/rp3
HTTP 409
X-Anas-Confirm-Code: f46dde678c92
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Removing SMB share 'rp3' stops sharing '/testpool/rp3'",
    "warnings": [
      "Removing SMB share 'rp3' makes the shared path '/testpool/rp3' inaccessible over SMB."
    ]
  }
}

$ api DELETE /shares/smb/rp3 'f46dde678c92'
HTTP 501
Unexpected content for method 'DELETE'
$ api GET /jobs/   (polled until done; status, operation, last progress, result, error)
{
  "status": null,
  "operation": null,
  "progress": null,
  "result": null,
  "error": null
}

$ api DELETE /shares/smb/rp4
HTTP 409
X-Anas-Confirm-Code: 777c5b3ab674
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Removing SMB share 'rp4' stops sharing '/testpool/rp4'",
    "warnings": [
      "Removing SMB share 'rp4' makes the shared path '/testpool/rp4' inaccessible over SMB."
    ]
  }
}

$ api DELETE /shares/smb/rp4 '777c5b3ab674'
HTTP 501
Unexpected content for method 'DELETE'
$ api GET /jobs/   (polled until done; status, operation, last progress, result, error)
{
  "status": null,
  "operation": null,
  "progress": null,
  "result": null,
  "error": null
}

$ api DELETE /shares/smb/rp4n
HTTP 409
X-Anas-Confirm-Code: 5ca337784246
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Removing SMB share 'rp4n' stops sharing '/testpool/rp4/n'",
    "warnings": [
      "Removing SMB share 'rp4n' makes the shared path '/testpool/rp4/n' inaccessible over SMB."
    ]
  }
}

$ api DELETE /shares/smb/rp4n '5ca337784246'
HTTP 501
Unexpected content for method 'DELETE'
$ api GET /jobs/   (polled until done; status, operation, last progress, result, error)
{
  "status": null,
  "operation": null,
  "progress": null,
  "result": null,
  "error": null
}

$ api DELETE /shares/smb/rp5
HTTP 409
X-Anas-Confirm-Code: 36835a75a61b
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Removing SMB share 'rp5' stops sharing '/srv/rpproof'",
    "warnings": [
      "Removing SMB share 'rp5' makes the shared path '/srv/rpproof' inaccessible over SMB."
    ]
  }
}

$ api DELETE /shares/smb/rp5 '36835a75a61b'
HTTP 501
Unexpected content for method 'DELETE'
$ api GET /jobs/   (polled until done; status, operation, last progress, result, error)
{
  "status": null,
  "operation": null,
  "progress": null,
  "result": null,
  "error": null
}

$ grep -cE "^\[(rp3|rp4|rp4n|rp5|rpdiag1|rpdiag2|rpdiag3)\]" /etc/samba/smb.conf
4

$ api DELETE /ahr/rpahr
HTTP 409
X-Anas-Confirm-Code: 83d441a96ced
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Destroying AHR pool 'rpahr' erases all of its data",
    "warnings": [
      "Pool 'rpahr' (0.99 GiB usable) will be permanently destroyed. Every array, partition, and all data is erased",
      "The filesystem at '/mnt/anas-ahr/rpahr' will be unmounted: anything serving from it (shares, backups, mounts) stops working"
    ]
  }
}

$ api DELETE /ahr/rpahr '83d441a96ced'
HTTP 501
Unexpected content for method 'DELETE'
$ api GET /jobs/   (polled until done; status, operation, last progress, result, error)
{
  "status": null,
  "operation": null,
  "progress": null,
  "result": null,
  "error": null
}

$ api DELETE /pools/testpool/datasets/rp1?recursive=true
HTTP 409
X-Anas-Confirm-Code: 5d8aa02fde5b
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Destroying dataset 'testpool/rp1' permanently erases its data",
    "warnings": [
      "Destroying 'testpool/rp1' is irreversible — all data in the dataset is permanently lost.",
      "1 child dataset(s) will also be destroyed."
    ]
  }
}

$ api DELETE /pools/testpool/datasets/rp1?recursive=true '5d8aa02fde5b'
HTTP 501
Unexpected content for method 'DELETE'
$ api GET /jobs/   (polled until done; status, operation, last progress, result, error)
{
  "status": null,
  "operation": null,
  "progress": null,
  "result": null,
  "error": null
}

$ api DELETE /pools/testpool/datasets/rp3
HTTP 409
X-Anas-Confirm-Code: b6747c6c5df1
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Destroying dataset 'testpool/rp3' permanently erases its data",
    "warnings": [
      "Destroying 'testpool/rp3' is irreversible — all data in the dataset is permanently lost.",
      "1 share(s) serve this dataset ('smb:rp3') and will stop working."
    ]
  }
}

$ api DELETE /pools/testpool/datasets/rp3 'b6747c6c5df1'
HTTP 501
Unexpected content for method 'DELETE'
$ api GET /jobs/   (polled until done; status, operation, last progress, result, error)
{
  "status": null,
  "operation": null,
  "progress": null,
  "result": null,
  "error": null
}

$ api DELETE /pools/testpool/datasets/rp4
HTTP 409
X-Anas-Confirm-Code: 4b633f9e7506
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Destroying dataset 'testpool/rp4' permanently erases its data",
    "warnings": [
      "Destroying 'testpool/rp4' is irreversible — all data in the dataset is permanently lost.",
      "1 share(s) serve this dataset ('smb:rp4') and will stop working."
    ]
  }
}

$ api DELETE /pools/testpool/datasets/rp4 '4b633f9e7506'
HTTP 501
Unexpected content for method 'DELETE'
$ api GET /jobs/   (polled until done; status, operation, last progress, result, error)
{
  "status": null,
  "operation": null,
  "progress": null,
  "result": null,
  "error": null
}

$ api DELETE /identity/users/rpuser
HTTP 409
{
  "error": {
    "code": "CONFLICT",
    "reason": "referenced-by-share",
    "message": "User 'rpuser' is referenced by share(s): rp3, rp4, rp4n, rp5. Remove it from their 'valid users' first. This refusal has no confirm bypass."
  }
}

$ api DELETE /identity/users/rpuser
HTTP 409
{
  "error": {
    "code": "CONFLICT",
    "reason": "referenced-by-share",
    "message": "User 'rpuser' is referenced by share(s): rp3, rp4, rp4n, rp5. Remove it from their 'valid users' first. This refusal has no confirm bypass."
  }
}

$ api GET /jobs/   (polled until done; status, operation, last progress, result, error)
{
  "status": null,
  "operation": null,
  "progress": null,
  "result": null,
  "error": null
}

$ api DELETE /identity/users/rpuser2
HTTP 409
{
  "error": {
    "code": "CONFLICT",
    "reason": "referenced-by-share",
    "message": "User 'rpuser2' is referenced by share(s): rp3, rp4n, rp5. Remove it from their 'valid users' first. This refusal has no confirm bypass."
  }
}

$ api DELETE /identity/users/rpuser2
HTTP 409
{
  "error": {
    "code": "CONFLICT",
    "reason": "referenced-by-share",
    "message": "User 'rpuser2' is referenced by share(s): rp3, rp4n, rp5. Remove it from their 'valid users' first. This refusal has no confirm bypass."
  }
}

$ api GET /jobs/   (polled until done; status, operation, last progress, result, error)
{
  "status": null,
  "operation": null,
  "progress": null,
  "result": null,
  "error": null
}

$ pvesm remove rpstore && rm -rf /srv/rpproof; ls -d /srv/rpproof /testpool/rp1 /testpool/rp3 /testpool/rp4 /mnt/anas-ahr/rpahr 2>&1
ls: cannot access '/srv/rpproof': No such file or directory
/mnt/anas-ahr/rpahr
/testpool/rp1
/testpool/rp3
/testpool/rp4

$ zpool list -H -o name; zfs list -r -H -o name,acltype testpool
gtbackup
gtiscsi
pvfix
sysfix
testpool
testpool	off
testpool/rp1	posix
testpool/rp1/kid	posix
testpool/rp3	posix
testpool/rp4	posix
testpool/share1	off

$ id rpuser rpuser2 2>&1; pdbedit -L | grep -c "^rpuser"
uid=1004(rpuser) gid=100(users) groups=100(users)
uid=1005(rpuser2) gid=100(users) groups=100(users)
2

$ lvs rpahr 2>&1; ls /dev/md/ 2>&1; grep -c rpahr /etc/fstab; ls /mnt/anas-ahr/
  LV        VG    Attr       LSize    Pool Origin Data%  Meta%  Move Log Cpy%Sync Convert
  rpahr-vol rpahr -wi-ao---- 1016.00m
rpahr-r1
1
accahr
ahr0
ahr2t
ahrpv
gtcache
gtexpand
lp34
lpahr
media
mini
pveup
rpahr
sh11
sh7
tank
test1
up0

(the four config files ANAS or this proof touched, against their sums taken before the deploy)

$ md5sum -c /root/rpproof/before.md5
/etc/samba/smb.conf: FAILED
/etc/pve/storage.cfg: FAILED
/etc/exports: OK
/etc/fstab: FAILED
md5sum: WARNING: 3 computed checksums did NOT match
```

```
### R8 (second run). teardown, through the API where ANAS made or manages it; shell only for the shell-made fixtures

$ api DELETE /shares/smb/rp3
HTTP 409
X-Anas-Confirm-Code: 6256f4e1fa4b
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Removing SMB share 'rp3' stops sharing '/testpool/rp3'",
    "warnings": [
      "Removing SMB share 'rp3' makes the shared path '/testpool/rp3' inaccessible over SMB."
    ]
  }
}

$ api DELETE /shares/smb/rp3   [X-Anas-Confirm: 6256f4e1fa4b]
HTTP 202
{
  "job": {
    "id": "ef54dc6c-86b7-44b5-a2b5-8815df02ddd3",
    "status": "running",
    "operation": "smb.share.remove",
    "createdAt": "2026-10-12T00:41:31.029Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/ef54dc6c-86b7-44b5-a2b5-8815df02ddd3   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.share.remove",
  "progress": null,
  "result": {
    "removed": "rp3"
  },
  "error": null
}

$ api DELETE /shares/smb/rp4
HTTP 409
X-Anas-Confirm-Code: 68ba9f03ee5b
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Removing SMB share 'rp4' stops sharing '/testpool/rp4'",
    "warnings": [
      "Removing SMB share 'rp4' makes the shared path '/testpool/rp4' inaccessible over SMB."
    ]
  }
}

$ api DELETE /shares/smb/rp4   [X-Anas-Confirm: 68ba9f03ee5b]
HTTP 202
{
  "job": {
    "id": "4ef8d534-75f3-427d-8a9d-ed1c6e7da663",
    "status": "running",
    "operation": "smb.share.remove",
    "createdAt": "2026-10-12T00:41:31.486Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/4ef8d534-75f3-427d-8a9d-ed1c6e7da663   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.share.remove",
  "progress": null,
  "result": {
    "removed": "rp4"
  },
  "error": null
}

$ api DELETE /shares/smb/rp4n
HTTP 409
X-Anas-Confirm-Code: 1d1a19e6fcd7
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Removing SMB share 'rp4n' stops sharing '/testpool/rp4/n'",
    "warnings": [
      "Removing SMB share 'rp4n' makes the shared path '/testpool/rp4/n' inaccessible over SMB."
    ]
  }
}

$ api DELETE /shares/smb/rp4n   [X-Anas-Confirm: 1d1a19e6fcd7]
HTTP 202
{
  "job": {
    "id": "eeec903d-d973-44c2-bf35-acb4bcf0d094",
    "status": "running",
    "operation": "smb.share.remove",
    "createdAt": "2026-10-12T00:41:32.007Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/eeec903d-d973-44c2-bf35-acb4bcf0d094   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.share.remove",
  "progress": null,
  "result": {
    "removed": "rp4n"
  },
  "error": null
}

$ api DELETE /shares/smb/rp5
HTTP 409
X-Anas-Confirm-Code: 3fb4e5a784d6
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Removing SMB share 'rp5' stops sharing '/srv/rpproof'",
    "warnings": [
      "Removing SMB share 'rp5' makes the shared path '/srv/rpproof' inaccessible over SMB."
    ]
  }
}

$ api DELETE /shares/smb/rp5   [X-Anas-Confirm: 3fb4e5a784d6]
HTTP 202
{
  "job": {
    "id": "5da156cf-7bcf-4ef1-8694-f711233c37c1",
    "status": "running",
    "operation": "smb.share.remove",
    "createdAt": "2026-10-12T00:41:32.572Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/5da156cf-7bcf-4ef1-8694-f711233c37c1   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.share.remove",
  "progress": null,
  "result": {
    "removed": "rp5"
  },
  "error": null
}

$ grep -cE "^\[(rp3|rp4|rp4n|rp5|rpdiag1|rpdiag2|rpdiag3)\]" /etc/samba/smb.conf
0

$ api DELETE /ahr/rpahr
HTTP 409
X-Anas-Confirm-Code: 08e4638e60d8
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Destroying AHR pool 'rpahr' erases all of its data",
    "warnings": [
      "Pool 'rpahr' (0.99 GiB usable) will be permanently destroyed. Every array, partition, and all data is erased",
      "The filesystem at '/mnt/anas-ahr/rpahr' will be unmounted: anything serving from it (shares, backups, mounts) stops working"
    ]
  }
}

$ api DELETE /ahr/rpahr   [X-Anas-Confirm: 08e4638e60d8]
HTTP 202
{
  "job": {
    "id": "a7c7c603-69c8-4b8a-ae33-e86fcd454c29",
    "status": "running",
    "operation": "ahr.destroy",
    "createdAt": "2026-10-12T00:41:33.351Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/a7c7c603-69c8-4b8a-ae33-e86fcd454c29   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "ahr.destroy",
  "progress": "Clearing the expansion record",
  "result": {
    "destroyed": "rpahr"
  },
  "error": null
}

$ api DELETE /pools/testpool/datasets/rp1?recursive=true
HTTP 409
X-Anas-Confirm-Code: 93fe7866acaa
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Destroying dataset 'testpool/rp1' permanently erases its data",
    "warnings": [
      "Destroying 'testpool/rp1' is irreversible — all data in the dataset is permanently lost.",
      "1 child dataset(s) will also be destroyed."
    ]
  }
}

$ api DELETE /pools/testpool/datasets/rp1?recursive=true   [X-Anas-Confirm: 93fe7866acaa]
HTTP 202
{
  "job": {
    "id": "88927f3e-a291-4d25-8925-442db2ab941e",
    "status": "running",
    "operation": "zfs.destroy",
    "createdAt": "2026-10-12T00:41:54.422Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/88927f3e-a291-4d25-8925-442db2ab941e   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "zfs.destroy",
  "progress": null,
  "result": {
    "destroyed": "testpool/rp1"
  },
  "error": null
}

$ api DELETE /pools/testpool/datasets/rp3
HTTP 409
X-Anas-Confirm-Code: 2876963cac55
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Destroying dataset 'testpool/rp3' permanently erases its data",
    "warnings": [
      "Destroying 'testpool/rp3' is irreversible — all data in the dataset is permanently lost."
    ]
  }
}

$ api DELETE /pools/testpool/datasets/rp3   [X-Anas-Confirm: 2876963cac55]
HTTP 202
{
  "job": {
    "id": "bd3c55e6-3937-4ecc-b165-a3af67844e4c",
    "status": "running",
    "operation": "zfs.destroy",
    "createdAt": "2026-10-12T00:41:55.127Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/bd3c55e6-3937-4ecc-b165-a3af67844e4c   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "zfs.destroy",
  "progress": null,
  "result": {
    "destroyed": "testpool/rp3"
  },
  "error": null
}

$ api DELETE /pools/testpool/datasets/rp4
HTTP 409
X-Anas-Confirm-Code: e3a4973affaa
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Destroying dataset 'testpool/rp4' permanently erases its data",
    "warnings": [
      "Destroying 'testpool/rp4' is irreversible — all data in the dataset is permanently lost."
    ]
  }
}

$ api DELETE /pools/testpool/datasets/rp4   [X-Anas-Confirm: e3a4973affaa]
HTTP 202
{
  "job": {
    "id": "05bf6455-b804-45e6-a031-7d3f524d2922",
    "status": "running",
    "operation": "zfs.destroy",
    "createdAt": "2026-10-12T00:41:55.742Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/05bf6455-b804-45e6-a031-7d3f524d2922   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "zfs.destroy",
  "progress": null,
  "result": {
    "destroyed": "testpool/rp4"
  },
  "error": null
}

$ api DELETE /identity/users/rpuser
HTTP 409
X-Anas-Confirm-Code: f466bf3f8484
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Deleting share user 'rpuser' removes the account",
    "warnings": [
      "User 'rpuser' (uid 1004) will be removed from the system",
      "Files owned by the user keep their uid (1004) — ownership is not changed, and a later user with the same uid would own them",
      "Its SMB password entry will be removed"
    ]
  }
}

$ api DELETE /identity/users/rpuser   [X-Anas-Confirm: f466bf3f8484]
HTTP 202
{
  "job": {
    "id": "13a64ff6-03ea-4ef1-8e01-67f679af0d48",
    "status": "running",
    "operation": "identity.user.delete",
    "createdAt": "2026-10-12T00:41:56.221Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/13a64ff6-03ea-4ef1-8e01-67f679af0d48   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "identity.user.delete",
  "progress": "Deleting share user 'rpuser'",
  "result": {
    "deleted": "rpuser",
    "smbEntryRemoved": true
  },
  "error": null
}

$ api DELETE /identity/users/rpuser2
HTTP 409
X-Anas-Confirm-Code: 7127ff6fe50e
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Deleting share user 'rpuser2' removes the account",
    "warnings": [
      "User 'rpuser2' (uid 1005) will be removed from the system",
      "Files owned by the user keep their uid (1005) — ownership is not changed, and a later user with the same uid would own them",
      "Its SMB password entry will be removed"
    ]
  }
}

$ api DELETE /identity/users/rpuser2   [X-Anas-Confirm: 7127ff6fe50e]
HTTP 202
{
  "job": {
    "id": "ebc6c510-e481-4c6a-95e9-a9ef9dda10e6",
    "status": "running",
    "operation": "identity.user.delete",
    "createdAt": "2026-10-12T00:41:56.637Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/ebc6c510-e481-4c6a-95e9-a9ef9dda10e6   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "identity.user.delete",
  "progress": "Deleting share user 'rpuser2'",
  "result": {
    "deleted": "rpuser2",
    "smbEntryRemoved": true
  },
  "error": null
}

$ grep -c "^dir: rpstore" /etc/pve/storage.cfg; ls -d /srv/rpproof /testpool/rp1 /testpool/rp3 /testpool/rp4 /mnt/anas-ahr/rpahr 2>&1
0
ls: cannot access '/srv/rpproof': No such file or directory
ls: cannot access '/testpool/rp1': No such file or directory
ls: cannot access '/testpool/rp3': No such file or directory
ls: cannot access '/testpool/rp4': No such file or directory
/mnt/anas-ahr/rpahr

$ zpool list -H -o name; zfs list -r -H -o name,acltype testpool
gtbackup
gtiscsi
pvfix
sysfix
testpool
testpool	off
testpool/share1	off

$ id rpuser rpuser2 2>&1; pdbedit -L | grep -c "^rpuser"
id: ‘rpuser’: no such user
id: ‘rpuser2’: no such user
0

$ lvs rpahr 2>&1; ls /dev/md/ 2>&1; grep -c rpahr /etc/fstab; ls /mnt/anas-ahr/
  Volume group "rpahr" not found
  Cannot process volume group rpahr
ls: cannot access '/dev/md/': No such file or directory
0
accahr
ahr0
ahr2t
ahrpv
gtcache
gtexpand
lp34
lpahr
media
mini
pveup
rpahr
sh11
sh7
tank
test1
up0

(the four config files ANAS or this proof touched, against their sums taken before the deploy)

$ md5sum -c /root/rpproof/before.md5
/etc/samba/smb.conf: OK
/etc/pve/storage.cfg: FAILED
/etc/exports: OK
/etc/fstab: OK
md5sum: WARNING: 1 computed checksum did NOT match
```

```
### R8b. the empty AHR mountpoint directory, storage.cfg, and node health after teardown (fixture disks detached from the host with ahrcache-fixture.sh down)

$ rmdir /mnt/anas-ahr/rpahr && ls -d /mnt/anas-ahr/rpahr 2>&1
ls: cannot access '/mnt/anas-ahr/rpahr': No such file or directory

$ grep -E "^[a-z]+: |^\s+content" /etc/pve/storage.cfg
zfspool: datapool
	content rootdir,images
dir: local
	content vztmpl,rootdir,snippets,images,backup,iso
zfspool: pvfix
	content images,rootdir
dir: pvfixdump
	content backup
zfspool: sysfix-data
	content rootdir,images

$ systemctl is-active anasd anas smbd; systemctl show -p NRestarts --value anasd; systemctl show -p ActiveEnterTimestamp --value anasd
active
active
active
0
Mon 2026-10-12 00:29:51 UTC

$ curl -s --unix-socket /run/anas/anasd.sock http://localhost/v1/health; echo
{"status":"ok","version":"0.4.2"}

$ api GET /health
HTTP 200
{
  "status": "ok",
  "version": "0.4.2"
}

$ lsblk -d -o NAME,SIZE,SERIAL | grep -c ANAS_HOT; ls /dev/disk/by-id | grep -cE "HOT(7|8|9)$"
2
0

$ journalctl -u anasd --since "2026-10-12 00:29:51" --no-pager -o cat | grep -cE "\"level\":(40|50|60)"
0

$ journalctl -u anas --since "2026-10-12 00:29:51" --no-pager -p warning -o cat | grep -v "\[auth\] Using pve auth provider" | wc -l
0

$ testparm -s 2>&1 >/dev/null | grep -iE "error|warn|unknown" | sort | uniq -c

$ cd /opt/anas/packages/daemon/dist && md5sum services/access.js parsers/smb-conf.js parsers/getfacl.js routes/shares-smb.js
29ef3cdc566d7a8600bcb41ffc4bb363  services/access.js
ff8634c23cf469bd957996023e777176  parsers/smb-conf.js
dcaf344ca50463eeb2094170d6b6631c  parsers/getfacl.js
6109770b49c418af0f6bb70723db6e71  routes/shares-smb.js

$ rm -rf /root/rpproof && ls -d /root/rpproof 2>&1
ls: cannot access '/root/rpproof': No such file or directory
```
