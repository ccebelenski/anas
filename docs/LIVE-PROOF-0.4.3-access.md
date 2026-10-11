# Live proof — access.1 / access.2: one permissions writer, the share-path grant, the AHR editor (GitHub #75)

Driven 2026-10-11 against the disposable stunt PVE 9 node `anas-pve` (192.168.200.50). Code under
test: main at `974a27a` (the access.1/access.2 rulings), put on the node with
`./test/stunt-node/deploy-anas.sh` (daemon and gateway report `0.4.2`; anasd active since
22:23:15 UTC). Nothing in the product was changed for this proof.

**Method.** Every mutation and every editor read went through the real front door, the way the
panels call it: a PVE ticket for `root@pam` (`POST /api2/json/access/ticket`), then
`https://localhost:8006/anas/api/nodes/anas-pve/v1<path>` with the `PVEAuthCookie` cookie and the
`CSRFPreventionToken` header (pveproxy → AnasProxy → gateway ticket check → anasd). The node's
gateway runs the PVE auth provider (no `ANAS_AUTH_PROVIDER` in `/etc/default/anas`), so no dev
account appears and nothing below is redacted. Request bodies are the ones the dialogs build
(`70-shares.js` `submitSmbShare`, `14-permissions.js` `submitAccess`): the share create sends
`grantAccess: {}` while the grant box is ticked, the editor sends owner, group, the base three and
the named rows. `api METHOD PATH [body] [X-Anas-Confirm]` prints the HTTP status, any
`X-Anas-Confirm-Code` header and the body; a job is polled until it ends, and the final job is
printed as its status, operation, last progress line, result and error. The shell was used to
observe (`getfacl`, `stat`, `zfs get`, `zpool history`, `testparm`, `smbclient`, journald) and to
make fixtures the API has no door for: files written as root, a btrfs subvolume, a
`mountpoint=legacy` child, a throwaway `dir` storage (`pvesm add`/`remove`), and the scratch files
of the §3x diagnosis. Each fenced block is one `ssh root@anas-pve 'bash -s'` run, verbatim (trailing
blanks and repeated blank lines squeezed).

**Fixtures.** `ahrcache-fixture.sh up` attached three blank virtual disks (hot7 and hot8, 1 GiB, for
the AHR pool; hot9, 512 MiB, for the fresh ZFS pool) and `down` detached them at the end. The
pvepool fixture (`pvfix`, `sysfix`) was already up when the run started and is left as found.

## Verdicts

| Scenario | Verdict |
|---|---|
| 1. Fresh ZFS pool, SMB share to a named user | **PROVEN** (§1). Mountpoint stays `root:root`; `getfacl` shows `user:accuser:rwx` plus the default entries; `smbclient put` as accuser succeeds; `GET /shares/smb/accz/access` shows exactly owner/owning-group/everyone + `accuser read-write`. The read-only edit keeps `user:accuser:rwx` (never lowered). Findings F2 and F5. |
| 2. Guest share | **PROVEN, with a deviation from the brief** (§2). `other::rwx` and `smbclient -N put` succeeds; there are **no default entries** (F4). |
| 3. Recursive apply is a 409 confirm | **PROVEN** (§3). 409 + `X-Anas-Confirm-Code`, headline names `/accz`; resend → 202, job completes, existing files carry the named entries; the non-recursive PUT is 202 unchallenged. Finding F1 (every file made executable and setgid). |
| 4. Child dataset with ACLs off | **PROVEN** (§4). The share door's 409 names the child and the switch; nothing is written before the resend (share 404, `acltype` still off); the job's `grant.childAclEnabled` is `["testpool/acc4/kid"]`; `kid` is `posix`/`sa` (local); `kid.txt` carries the entry; the `/accaway` and `legacy` children are not listed. Note F6. |
| 5. AHR pool editor | **PROVEN** (§5). `GET /v1/ahr/accahr/access` has the dataset payload's keys plus `backing: "ahr"`; the named PUT lands on the `@data` mount; no `zfs set` ran (`zpool history` unchanged on every pool; the job completed); the recursive 409 carries the subvolume sentence and the sweep reaches the file inside subvolume `sub1`; the snapshot's copy under `@snapshots` keeps its ACL; an SMB share on the pool to accuser2 → `smbclient put` succeeds. |
| 6. PVE-owned path | **PROVEN as the story built it** (§6). A PVE-owned ZFS path refuses the share itself (400, pvepool.1); a non-ZFS directory inside `local`'s path → share created, `grant.status: "refused"` with the gate's sentence, ACL unchanged; a recursive grant on a directory holding a `dir` storage → share created, grant refused, ACL unchanged. Finding F3. |
| 7. Negatives | **Wrong confirm code: PROVEN** (§3b): re-challenged with a fresh code, nothing written. **Degraded ACL: NOT RUN** (see decisions). |
| 8. Teardown | **PROVEN** (§8). Shares, users, datasets, both pools, the throwaway storage and directories removed; disks detached; `anasd anas smbd` active, NRestarts 0, `/v1/health` ok on the socket and through the front door, 0 warning-or-worse lines from anasd or the gateway since the deploy; the node runs this build. |

## Findings

**F1 — A recursive apply makes every plain file executable, and setgid.** §3: `s3-old.txt` was
`-rw-r--r--`; after the confirmed recursive PUT it is `-rwxrwsr-x` with `user::rwx`,
`user:accuser:rwx`, `group::r-x`, `other::r-x`. The same in §4 (`kid.txt`) and §5 (`top.txt`,
`sub1/insub.txt`, AHR). An executable fixture (`s3-tool`, `root:root 0755`) ends `-rwxrwsr-x`: a
setgid-root binary anyone can run. Cause, from the code and the §3x diagnosis on scratch files:
`levelToAclPerms('read-write', true)` returns a literal `rwx` (`parsers/getfacl.ts`), and `setfacl
--set` resolves `X` against the ACL it is building, so once `u::rwx` is in the spec every `r-X`
becomes `r-x` as well (file `a`: `-rwxrwxr-x`); with `rwX` for read-write the files keep no
execute bit, and with `m::rwX` the mask stays `rw-` too (files `b`, `c`). The `chmod -R g+s` step
then sets setgid on every file (`s` where the group-class bits carry x, `S` where they do not,
file `c`). The docstring's "a recursive grant does not sprinkle spurious execute onto plain data
files" does not hold live, and the `chmod -R g+s` "ASSUMPTION (verify live)" comment in
`services/access.ts` is answered here: it marks every file. This is the Epic 4.7.2 writer, not new
in access.1, but access.1 adds two more doors to it. Not fixed: `getfacl.test.ts` asserts
`levelToAclPerms('read-write', true) === 'rwx'` and three route tests pin the spec, so the change
is a decision, not a one-liner. The direction the diagnosis supports: `rwX` and `m::rwX` in the
recursive spec, and `g+s` on directories only.

**F2 — Files and directories written over SMB do not give the other named principals their
access.** §1c: accuser writes `s1-put.txt` over SMB; it lands `-rwxr--r--`, `mask::r--`, so
`user:accuser2:rwx #effective:r--`. accuser2's `put` over it is `NT_STATUS_ACCESS_DENIED`; a
directory accuser makes over SMB gets `mask::r-x`, and accuser2's write into it is denied as well.
The share's effective Samba settings (§1e): `create mask = 0744`, `directory mask = 0755`,
`inherit acls = No`. The same writes made locally (`runuser -u accuser`) inherit correctly
(`mask::rw-` on the file, `mask::rwx` on the directory). So a share with two named users works
for each user's own files only. The cause is in the share's Samba parameters, not in the ACL the
grant wrote; whether the share writer should set `inherit acls = yes` (or the masks) when it
grants named principals is a design decision. smb.conf was not edited by hand to try it.

**F3 — The share door asks the recursive confirm before a refusal it then reports.** §6c:
`POST /shares/smb` with `grantAccess.applyToExisting` on `/srv/accpve` (a `dir` storage path
inside it) answers the 409 "Applying to existing files rewrites the permissions of every file and
directory under '/srv/accpve'"; after the resend the share is created and
`grant.status: "refused"`, "Recursive permission change of '/srv/accpve' would include
/srv/accpve/store — the path of PVE storage 'accpvestore'". The editor door on the same path
answers that refusal as a 400 with no confirm (§6d). Ruling (1) says the confirm is asked after
every refusal; on the share door the operator confirms a rewrite that is then refused.

**F4 — The guest grant writes mode bits only, with no default entries.** §2: on a dataset with
`acltype=off` the guest share's grant is `chmod 757` (job progress `chmod 757
/testpool/accguest`); `acltype` stays off and `getfacl` shows `other::rwx` and no `default:`
lines. The writer adds ACL entries only for named principals, so Everyone alone never switches
ACLs on. Over SMB this does not show (every guest session is `nobody`; the guest's file is
`nobody:nogroup -rwxr--r--`), but files placed there by root or another tool are not
guest-writable, and the brief's "default entries" expectation is not met.

**F5 — A read-only edit's result reports the requested level, not the one kept.** §1d: the job
result says `granted: [{accuser, read}, {accuser2, read}]` while the path keeps
`user:accuser:rwx` and `user:accuser2:rwx` (the never-lower rule, proven). The dialog only alerts
on refused/failed, so this shows in the API result alone.

**F6 — Note: children that inherit `acltype` switch with the parent.** §4: `testpool/acc4/away`
(mounted at `/accaway`) and `testpool/acc4/leg` (`legacy`) are correctly absent from
`childAclEnabled`, and both end `acltype posix inherited from testpool/acc4`: the parent's own
first-grant `zfs set` changes every child that inherits the property, wherever it is mounted. No
permission on them changed (`/accaway/away.txt` untouched). The confirm's warnings name only
`kid`.

## Decisions taken where the brief was open or did not match the node

- **Auth.** The brief says "the dev auth provider the stunt scripts use"; the node's gateway runs
  PVE auth, and the stunt scripts that drive the API (`ident3-gt.sh`) talk to the daemon socket
  with `x-anas-user` headers, which skips the gateway. A PVE ticket through `:8006` is the
  panels' own path, so that is what was used.
- **Pools.** The fresh ZFS pool `accz` (scenarios 1 and 3) was created through `POST /v1/pools` on
  the blank hot9, and the share sits on the pool root (the resolver's pool-root case). Scenarios 2
  and 4 use new datasets on `testpool` (`acltype=off`), because after §1 `accz` has `posixacl` on
  its root and every child of it would inherit that, which would leave no "ACLs off" child to test.
- **"No zfs set" (5).** anasd logs jobs, not commands, and the node has no strace or audit tooling
  (not installed: no package changes). Every successful `zfs set` is recorded in `zpool history`,
  and a failed one would have failed the job, so the evidence is the job's success plus unchanged
  history line counts on every pool.
- **PVE-owned path (6).** The brief expects a share on a PVE-owned path to be created with the
  grant refused; the access.1 result paragraph says a PVE-owned ZFS path refuses the share itself
  (pvepool.1) and names the share-created cases (a non-ZFS path inside a `dir` storage; a
  recursive grant whose tree holds PVE territory). All three were run. The third needed a `dir`
  storage inside a non-ZFS directory, so a throwaway one was made with `pvesm add` and removed in §8.
- **Degraded ACL (7).** `aclDegraded` needs `getfacl` to fail on a directory that stats fine with
  `acltype=posixacl`. That cannot be produced without tampering with the acl tools or the kernel,
  so it was not run; the unit tests cover the branch.
- **Two users in §1.** A second share user was added to see what one user's SMB-written file gives
  another; that is where F2 came from.

## §1 — Fresh ZFS pool, SMB share to a named user

```
### 1a. fixtures: a fresh pool and a share user, through the API

$ date -u '+%Y-%m-%d %H:%M:%S' | tee /root/accproof/mark-1
2026-10-11 22:25:48

$ ls -l /dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9
lrwxrwxrwx 1 root root 9 Oct 11 22:25 /dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9 -> ../../sdf

$ api POST /pools '{"name":"accz","dataVdevs":[{"type":"stripe","disks":["scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9"]}]}'
HTTP 202
{
  "job": {
    "id": "352d4143-852b-4c89-9277-d1940915e467",
    "status": "running",
    "operation": "zpool.create",
    "createdAt": "2026-10-11T22:25:48.907Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/352d4143-852b-4c89-9277-d1940915e467   (polled until done)
{
  "id": "352d4143-852b-4c89-9277-d1940915e467",
  "status": "completed",
  "operation": "zpool.create",
  "progress": null,
  "createdAt": "2026-10-11T22:25:48.907Z",
  "createdBy": "root",
  "startedAt": "2026-10-11T22:25:48.907Z",
  "completedAt": "2026-10-11T22:25:49.417Z",
  "result": null,
  "error": null,
  "detail": null
}

$ zfs get -H -o property,value mountpoint,acltype,xattr accz
mountpoint	/accz
acltype	off
xattr	sa

$ stat -c '%U:%G %a %n' /accz
root:root 755 /accz

$ getfacl -p /accz
# file: /accz
# owner: root
# group: root
user::rwx
group::r-x
other::r-x

$ api POST /identity/users '{"name":"accuser","smbPassword":"Acc-proof-1"}'
HTTP 202
{
  "job": {
    "id": "2bf7b892-9431-460d-99e8-4559c5bd1f62",
    "status": "running",
    "operation": "identity.user.add",
    "createdAt": "2026-10-11T22:25:50.394Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/2bf7b892-9431-460d-99e8-4559c5bd1f62   (polled until done)
{
  "id": "2bf7b892-9431-460d-99e8-4559c5bd1f62",
  "status": "completed",
  "operation": "identity.user.add",
  "progress": "Setting SMB password for 'accuser'",
  "createdAt": "2026-10-11T22:25:50.394Z",
  "createdBy": "root",
  "startedAt": "2026-10-11T22:25:50.394Z",
  "completedAt": "2026-10-11T22:25:50.671Z",
  "result": {
    "created": "accuser",
    "smbEnabled": true
  },
  "error": null,
  "detail": null
}

$ id accuser; pdbedit -L | grep accuser
uid=1004(accuser) gid=100(users) groups=100(users)
accuser:1004:

```

```
### 1b. SMB share on the fresh pool root to accuser, grant ON (the dialog's create body)

$ api POST /shares/smb '{"name":"accz","path":"/accz","comment":"","browseable":true,"readOnly":false,"guestOk":false,"validUsers":["accuser"],"hostsAllow":[],"hostsDeny":[],"grantAccess":{}}'
HTTP 202
{
  "job": {
    "id": "5164d4e4-1d57-4930-bab5-6cdaea8676bf",
    "status": "running",
    "operation": "smb.share.add",
    "createdAt": "2026-10-11T22:25:59.566Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/5164d4e4-1d57-4930-bab5-6cdaea8676bf   (polled until done)
{
  "id": "5164d4e4-1d57-4930-bab5-6cdaea8676bf",
  "status": "completed",
  "operation": "smb.share.add",
  "progress": "chmod g+s /accz",
  "createdAt": "2026-10-11T22:25:59.566Z",
  "createdBy": "root",
  "startedAt": "2026-10-11T22:25:59.566Z",
  "completedAt": "2026-10-11T22:25:59.914Z",
  "result": {
    "created": "accz",
    "grant": {
      "status": "applied",
      "path": "/accz",
      "granted": [
        {
          "kind": "user",
          "name": "accuser",
          "level": "read-write"
        }
      ],
      "skipped": [],
      "applyToExisting": false
    }
  },
  "error": null,
  "detail": null
}

$ testparm -s --section-name=accz 2>/dev/null

[accz]
	path = /accz
	read only = No
	valid users = accuser

$ zfs get -H -o property,value,source acltype,xattr accz
acltype	posix	local
xattr	sa	local

$ stat -c '%U:%G %A %n' /accz
root:root drwxrwsr-x /accz

$ getfacl -p /accz
# file: /accz
# owner: root
# group: root
# flags: -s-
user::rwx
user:accuser:rwx
group::r-x
mask::rwx
other::r-x
default:user::rwx
default:user:accuser:rwx
default:group::r-x
default:mask::rwx
default:other::r-x

$ echo 'written by accuser over SMB' > /root/accproof/s1-put.txt

$ smbclient //localhost/accz -U 'accuser%Acc-proof-1' -c 'put /root/accproof/s1-put.txt s1-put.txt; ls'
putting file /root/accproof/s1-put.txt as \s1-put.txt (9.1 kb/s) (average 9.1 kb/s)
  .                                   D        0  Sun Oct 11 22:26:00 2026
  ..                                  D        0  Sun Oct 11 22:26:00 2026
  s1-put.txt                          A       28  Sun Oct 11 22:26:00 2026

		360320 blocks of size 1024. 360192 blocks available

$ stat -c '%U:%G %A %n' /accz/s1-put.txt
accuser:root -rwxr--r-- /accz/s1-put.txt

$ getfacl -p /accz/s1-put.txt
# file: /accz/s1-put.txt
# owner: accuser
# group: root
user::rwx
user:accuser:rwx	#effective:r--
group::r-x	#effective:r--
mask::r--
other::r--

$ api GET /shares/smb/accz/access
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
        "name": "accuser",
        "level": "read-write"
      }
    ],
    "aclText": "# file: /accz\n# owner: root\n# group: root\n# flags: -s-\nuser::rwx\nuser:accuser:rwx\ngroup::r-x\nmask::rwx\nother::r-x\ndefault:user::rwx\ndefault:user:accuser:rwx\ndefault:group::r-x\ndefault:mask::rwx\ndefault:other::r-x\n\n",
    "backing": "zfs"
  }
}

```

```
### 1c. a second principal added on an edit; what a file one user wrote over SMB gives the other

$ api POST /identity/users '{"name":"accuser2","smbPassword":"Acc-proof-2"}'
HTTP 202
{
  "job": {
    "id": "6fc9690a-fb30-4842-b690-79602fa2a34a",
    "status": "running",
    "operation": "identity.user.add",
    "createdAt": "2026-10-11T22:26:18.887Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/6fc9690a-fb30-4842-b690-79602fa2a34a   (polled until done)
{
  "id": "6fc9690a-fb30-4842-b690-79602fa2a34a",
  "status": "completed",
  "operation": "identity.user.add",
  "progress": "Setting SMB password for 'accuser2'",
  "createdAt": "2026-10-11T22:26:18.887Z",
  "createdBy": "root",
  "startedAt": "2026-10-11T22:26:18.887Z",
  "completedAt": "2026-10-11T22:26:19.008Z",
  "result": {
    "created": "accuser2",
    "smbEnabled": true
  },
  "error": null,
  "detail": null
}

$ api PUT /shares/smb/accz '{"path":"/accz","comment":"","browseable":true,"readOnly":false,"guestOk":false,"validUsers":["accuser","accuser2"],"hostsAllow":[],"hostsDeny":[],"grantAccess":{}}'
HTTP 202
{
  "job": {
    "id": "610a5b4d-cccf-48e6-873a-28f5b7a62a59",
    "status": "running",
    "operation": "smb.config.set",
    "createdAt": "2026-10-11T22:26:20.148Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/610a5b4d-cccf-48e6-873a-28f5b7a62a59   (polled until done)
{
  "id": "610a5b4d-cccf-48e6-873a-28f5b7a62a59",
  "status": "completed",
  "operation": "smb.config.set",
  "progress": "chmod g+s /accz",
  "createdAt": "2026-10-11T22:26:20.148Z",
  "createdBy": "root",
  "startedAt": "2026-10-11T22:26:20.148Z",
  "completedAt": "2026-10-11T22:26:20.324Z",
  "result": {
    "updated": "accz",
    "grant": {
      "status": "applied",
      "path": "/accz",
      "granted": [
        {
          "kind": "user",
          "name": "accuser",
          "level": "read-write"
        },
        {
          "kind": "user",
          "name": "accuser2",
          "level": "read-write"
        }
      ],
      "skipped": [],
      "applyToExisting": false
    }
  },
  "error": null,
  "detail": null
}

$ getfacl -p /accz
# file: /accz
# owner: root
# group: root
# flags: -s-
user::rwx
user:accuser:rwx
user:accuser2:rwx
group::r-x
mask::rwx
other::r-x
default:user::rwx
default:user:accuser:rwx
default:user:accuser2:rwx
default:group::r-x
default:mask::rwx
default:other::r-x

$ echo 'accuser2 appends' > /root/accproof/s1c-append.txt

$ smbclient //localhost/accz -U 'accuser2%Acc-proof-2' -c 'put /root/accproof/s1c-append.txt s1c-new.txt; put /root/accproof/s1c-append.txt s1-put.txt; ls'
putting file /root/accproof/s1c-append.txt as \s1c-new.txt (16.6 kb/s) (average 16.6 kb/s)
NT_STATUS_ACCESS_DENIED opening remote file \s1-put.txt
  .                                   D        0  Sun Oct 11 22:26:21 2026
  ..                                  D        0  Sun Oct 11 22:26:21 2026
  s1-put.txt                          A       28  Sun Oct 11 22:26:00 2026
  s1c-new.txt                         A       17  Sun Oct 11 22:26:21 2026

		360192 blocks of size 1024. 360064 blocks available

$ getfacl -p /accz/s1c-new.txt
# file: /accz/s1c-new.txt
# owner: accuser2
# group: root
user::rwx
user:accuser:rwx	#effective:r--
user:accuser2:rwx	#effective:r--
group::r-x	#effective:r--
mask::r--
other::r--

$ smbclient //localhost/accz -U 'accuser%Acc-proof-1' -c 'mkdir s1c-dir'

$ getfacl -p /accz/s1c-dir
# file: /accz/s1c-dir
# owner: accuser
# group: root
# flags: -s-
user::rwx
user:accuser:rwx	#effective:r-x
user:accuser2:rwx	#effective:r-x
group::r-x
mask::r-x
other::r-x
default:user::rwx
default:user:accuser:rwx
default:user:accuser2:rwx
default:group::r-x
default:mask::rwx
default:other::r-x

$ smbclient //localhost/accz -U 'accuser2%Acc-proof-2' -c 'cd s1c-dir; put /root/accproof/s1c-append.txt in-dir.txt'
NT_STATUS_ACCESS_DENIED opening remote file \s1c-dir\in-dir.txt

### 1d. the share edited to read-only: the grant never lowers

$ api PUT /shares/smb/accz '{"path":"/accz","comment":"","browseable":true,"readOnly":true,"guestOk":false,"validUsers":["accuser","accuser2"],"hostsAllow":[],"hostsDeny":[],"grantAccess":{}}'
HTTP 202
{
  "job": {
    "id": "da1690c6-f498-47be-895b-978c31c00f5b",
    "status": "running",
    "operation": "smb.config.set",
    "createdAt": "2026-10-11T22:26:21.675Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/da1690c6-f498-47be-895b-978c31c00f5b   (polled until done)
{
  "id": "da1690c6-f498-47be-895b-978c31c00f5b",
  "status": "completed",
  "operation": "smb.config.set",
  "progress": "chmod g+s /accz",
  "createdAt": "2026-10-11T22:26:21.675Z",
  "createdBy": "root",
  "startedAt": "2026-10-11T22:26:21.675Z",
  "completedAt": "2026-10-11T22:26:21.952Z",
  "result": {
    "updated": "accz",
    "grant": {
      "status": "applied",
      "path": "/accz",
      "granted": [
        {
          "kind": "user",
          "name": "accuser",
          "level": "read"
        },
        {
          "kind": "user",
          "name": "accuser2",
          "level": "read"
        }
      ],
      "skipped": [],
      "applyToExisting": false
    }
  },
  "error": null,
  "detail": null
}

$ testparm -s --section-name=accz 2>/dev/null

[accz]
	path = /accz
	valid users = accuser accuser2

$ getfacl -p /accz
# file: /accz
# owner: root
# group: root
# flags: -s-
user::rwx
user:accuser:rwx
user:accuser2:rwx
group::r-x
mask::rwx
other::r-x
default:user::rwx
default:user:accuser:rwx
default:user:accuser2:rwx
default:group::r-x
default:mask::rwx
default:other::r-x

$ api GET /shares/smb/accz/access
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
        "name": "accuser",
        "level": "read-write"
      },
      {
        "kind": "user",
        "name": "accuser2",
        "level": "read-write"
      }
    ],
    "aclText": "# file: /accz\n# owner: root\n# group: root\n# flags: -s-\nuser::rwx\nuser:accuser:rwx\nuser:accuser2:rwx\ngroup::r-x\nmask::rwx\nother::r-x\ndefault:user::rwx\ndefault:user:accuser:rwx\ndefault:user:accuser2:rwx\ndefault:group::r-x\ndefault:mask::rwx\ndefault:other::r-x\n\n",
    "backing": "zfs"
  }
}

$ smbclient //localhost/accz -U 'accuser%Acc-proof-1' -c 'put /root/accproof/s1-put.txt s1d-ro.txt'
NT_STATUS_ACCESS_DENIED opening remote file \s1d-ro.txt

```

The last `put` is refused by Samba (`read only = Yes` is now the share's default, so testparm no
longer prints `read only = No`), not by the ACL. §1e: the same writes made outside Samba, then the
share's effective masks.

```
### 1e. local writes as accuser (no Samba)

$ runuser -u accuser -- sh -c 'echo local > /accz/s1e-local.txt; mkdir /accz/s1e-localdir'

$ getfacl -p /accz/s1e-local.txt /accz/s1e-localdir
# file: /accz/s1e-local.txt
# owner: accuser
# group: root
user::rw-
user:accuser:rwx	#effective:rw-
user:accuser2:rwx	#effective:rw-
group::r-x	#effective:r--
mask::rw-
other::r--

# file: /accz/s1e-localdir
# owner: accuser
# group: root
# flags: -s-
user::rwx
user:accuser:rwx
user:accuser2:rwx
group::r-x
mask::rwx
other::r-x
default:user::rwx
default:user:accuser:rwx
default:user:accuser2:rwx
default:group::r-x
default:mask::rwx
default:other::r-x
```

```
### 1e. why: the share's effective create/directory masks, and the same inheritance outside Samba

$ testparm -s --section-name=accz --parameter-name='create mask' 2>/dev/null
0744

$ testparm -s --section-name=accz --parameter-name='directory mask' 2>/dev/null
0755

$ testparm -s --section-name=accz --parameter-name='inherit acls' 2>/dev/null
No

$ testparm -s --section-name=accz --parameter-name='inherit permissions' 2>/dev/null
No

$ testparm -s --section-name=accz --parameter-name='map archive' 2>/dev/null
Yes

```

## §2 — Guest share

```
### 2. guest share, no users, grant ON, on a fresh dataset (testpool has acltype=off)

$ api POST /pools/testpool/datasets '{"path":"accguest"}'
HTTP 202
{
  "job": {
    "id": "7a6a6a67-abe2-4e9e-a643-c1a35efa18fa",
    "status": "running",
    "operation": "zfs.create",
    "createdAt": "2026-10-11T22:27:30.731Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/7a6a6a67-abe2-4e9e-a643-c1a35efa18fa   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "zfs.create",
  "progress": null,
  "result": {
    "created": "testpool/accguest"
  },
  "error": null
}

$ zfs get -H -o property,value,source acltype,xattr testpool/accguest
acltype	off	default
xattr	sa	default

$ stat -c '%U:%G %A %n' /testpool/accguest
root:root drwxr-xr-x /testpool/accguest

$ api POST /shares/smb '{"name":"accguest","path":"/testpool/accguest","comment":"","browseable":true,"readOnly":false,"guestOk":true,"validUsers":[],"hostsAllow":[],"hostsDeny":[],"grantAccess":{}}'
HTTP 202
{
  "job": {
    "id": "6c3cc192-70e8-4aa9-9b22-b1485dc881ba",
    "status": "running",
    "operation": "smb.share.add",
    "createdAt": "2026-10-11T22:27:31.003Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/6c3cc192-70e8-4aa9-9b22-b1485dc881ba   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.share.add",
  "progress": "chmod 757 /testpool/accguest",
  "result": {
    "created": "accguest",
    "grant": {
      "status": "applied",
      "path": "/testpool/accguest",
      "granted": [
        {
          "kind": "everyone",
          "level": "read-write"
        }
      ],
      "skipped": [],
      "applyToExisting": false
    }
  },
  "error": null
}

$ testparm -s --section-name=accguest 2>/dev/null

[accguest]
	guest ok = Yes
	path = /testpool/accguest
	read only = No

$ zfs get -H -o property,value,source acltype testpool/accguest
acltype	off	default

$ stat -c '%U:%G %A %n' /testpool/accguest
root:root drwxr-xrwx /testpool/accguest

$ getfacl -p /testpool/accguest
# file: /testpool/accguest
# owner: root
# group: root
user::rwx
group::r-x
other::rwx

$ echo 'guest wrote this' > /root/accproof/s2-put.txt

$ smbclient -N //localhost/accguest -c 'put /root/accproof/s2-put.txt s2-put.txt; ls'
putting file /root/accproof/s2-put.txt as \s2-put.txt (16.6 kb/s) (average 16.6 kb/s)
  .                                   D        0  Sun Oct 11 22:27:32 2026
  ..                                  D        0  Sun Oct 11 22:27:32 2026
  s2-put.txt                          A       17  Sun Oct 11 22:27:32 2026

		1834624 blocks of size 1024. 1834496 blocks available

$ stat -c '%U:%G %A %n' /testpool/accguest/s2-put.txt
nobody:nogroup -rwxr--r-- /testpool/accguest/s2-put.txt

$ api GET /shares/smb/accguest/access
HTTP 200
{
  "data": {
    "owner": "root",
    "group": "root",
    "aclSupported": true,
    "aclEnabled": false,
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
        "level": "read-write"
      }
    ],
    "aclText": null,
    "backing": "zfs"
  }
}

```

## §3 — Recursive apply is a 409 confirm (with §7a, a wrong code)

```
### 3. recursive apply on the share path is a 409 confirm (and a wrong code is re-challenged — §7)

$ mkdir /accz/s3dir && echo old > /accz/s3dir/old.txt && echo old > /accz/s3-old.txt && cp /usr/bin/true /accz/s3-tool && chmod 0755 /accz/s3-tool && setfacl -b /accz/s3-old.txt /accz/s3dir /accz/s3dir/old.txt /accz/s3-tool && setfacl -k /accz/s3dir

$ stat -c '%U:%G %A %n' /accz/s3-old.txt /accz/s3dir /accz/s3dir/old.txt /accz/s3-tool
root:root -rw-r--r-- /accz/s3-old.txt
root:root drwxr-sr-x /accz/s3dir
root:root -rw-r--r-- /accz/s3dir/old.txt
root:root -rwxr-xr-x /accz/s3-tool

$ getfacl -p /accz/s3-old.txt /accz/s3dir
# file: /accz/s3-old.txt
# owner: root
# group: root
user::rw-
group::r--
other::r--

# file: /accz/s3dir
# owner: root
# group: root
# flags: -s-
user::rwx
group::r-x
other::r-x

--- 3a. no confirm header
$ api PUT /shares/smb/accz/access '{"owner":"root","group":"root","entries":[{"kind":"owner","level":"read-write"},{"kind":"owning-group","level":"read"},{"kind":"everyone","level":"read"},{"kind":"user","name":"accuser","level":"read-write"},{"kind":"user","name":"accuser2","level":"read-write"}],"applyToExisting":true}'
HTTP 409
X-Anas-Confirm-Code: 499d4c83f661
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Applying to existing files rewrites the permissions of every file and directory under '/accz'",
    "warnings": [
      "The current permissions are not recorded anywhere, so this cannot be undone."
    ]
  }
}

--- 3b (§7). a wrong confirm code
$ api PUT /shares/smb/accz/access '{"owner":"root","group":"root","entries":[{"kind":"owner","level":"read-write"},{"kind":"owning-group","level":"read"},{"kind":"everyone","level":"read"},{"kind":"user","name":"accuser","level":"read-write"},{"kind":"user","name":"accuser2","level":"read-write"}],"applyToExisting":true}'   [X-Anas-Confirm: 00000000]
HTTP 409
X-Anas-Confirm-Code: 0a9b632f3906
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Applying to existing files rewrites the permissions of every file and directory under '/accz'",
    "warnings": [
      "The current permissions are not recorded anywhere, so this cannot be undone."
    ]
  }
}

$ getfacl -p /accz/s3-old.txt
# file: /accz/s3-old.txt
# owner: root
# group: root
user::rw-
group::r--
other::r--

--- 3c. resend with the code the last 409 carried
$ api PUT /shares/smb/accz/access '{"owner":"root","group":"root","entries":[{"kind":"owner","level":"read-write"},{"kind":"owning-group","level":"read"},{"kind":"everyone","level":"read"},{"kind":"user","name":"accuser","level":"read-write"},{"kind":"user","name":"accuser2","level":"read-write"}],"applyToExisting":true}'   [X-Anas-Confirm: 0a9b632f3906]
HTTP 202
{
  "job": {
    "id": "d27b9161-4941-4775-a219-3185a776513c",
    "status": "running",
    "operation": "fs.setAccess",
    "createdAt": "2026-10-11T22:27:54.649Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/d27b9161-4941-4775-a219-3185a776513c   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "fs.setAccess",
  "progress": "chmod g+s /accz",
  "result": {
    "path": "/accz",
    "aclEnabled": true,
    "aclAutoEnabled": false,
    "namedCount": 2,
    "childAclEnabled": []
  },
  "error": null
}

$ stat -c '%U:%G %A %n' /accz/s3-old.txt /accz/s3dir /accz/s3dir/old.txt /accz/s3-tool
root:root -rwxrwsr-x /accz/s3-old.txt
root:root drwxrwsr-x /accz/s3dir
root:root -rwxrwsr-x /accz/s3dir/old.txt
root:root -rwxrwsr-x /accz/s3-tool

$ getfacl -p /accz/s3-old.txt /accz/s3dir /accz/s3dir/old.txt /accz/s3-tool
# file: /accz/s3-old.txt
# owner: root
# group: root
# flags: -s-
user::rwx
user:accuser:rwx
user:accuser2:rwx
group::r-x
mask::rwx
other::r-x

# file: /accz/s3dir
# owner: root
# group: root
# flags: -s-
user::rwx
user:accuser:rwx
user:accuser2:rwx
group::r-x
mask::rwx
other::r-x
default:user::rwx
default:user:accuser:rwx
default:user:accuser2:rwx
default:group::r-x
default:mask::rwx
default:other::r-x

# file: /accz/s3dir/old.txt
# owner: root
# group: root
# flags: -s-
user::rwx
user:accuser:rwx
user:accuser2:rwx
group::r-x
mask::rwx
other::r-x

# file: /accz/s3-tool
# owner: root
# group: root
# flags: -s-
user::rwx
user:accuser:rwx
user:accuser2:rwx
group::r-x
mask::rwx
other::r-x

--- 3d. a non-recursive PUT is not challenged
$ api PUT /shares/smb/accz/access '{"owner":"root","group":"root","entries":[{"kind":"owner","level":"read-write"},{"kind":"owning-group","level":"read"},{"kind":"everyone","level":"read"},{"kind":"user","name":"accuser","level":"read-write"},{"kind":"user","name":"accuser2","level":"read-write"}],"applyToExisting":false}'
HTTP 202
{
  "job": {
    "id": "d17f0a10-00d7-4b49-ac75-18cf243a0cf1",
    "status": "running",
    "operation": "fs.setAccess",
    "createdAt": "2026-10-11T22:27:55.001Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/d17f0a10-00d7-4b49-ac75-18cf243a0cf1   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "fs.setAccess",
  "progress": "chmod g+s /accz",
  "result": {
    "path": "/accz",
    "aclEnabled": true,
    "aclAutoEnabled": false,
    "namedCount": 2
  },
  "error": null
}

```

```
### 3x. diagnosis (scratch files under /root, ZFS-free ext4, no product path): how setfacl resolves X in the spec the writer sends

$ rm -rf /root/accproof/xt && mkdir -p /root/accproof/xt && cd /root/accproof/xt && for f in a b c d; do echo data > $f; chmod 0644 $f; done && dpkg -s acl | grep '^Version'
Version: 2.3.2-2+b1

$ cd /root/accproof/xt && setfacl --set 'u::rwx,g::r-X,o::r-X,u:accuser:rwx,m::rwx' a && stat -c '%A %n' a
-rwxrwxr-x a

$ cd /root/accproof/xt && setfacl --set 'u::rwX,g::r-X,o::r-X,u:accuser:rwX,m::rwx' b && stat -c '%A %n' b && getfacl -p b
-rw-rwxr-- b
# file: b
# owner: root
# group: root
user::rw-
user:accuser:rw-
group::r--
mask::rwx
other::r--

$ cd /root/accproof/xt && setfacl --set 'u::rwX,g::r-X,o::r-X,u:accuser:rwX,m::rwX' c && stat -c '%A %n' c && getfacl -p c
-rw-rw-r-- c
# file: c
# owner: root
# group: root
user::rw-
user:accuser:rw-
group::r--
mask::rw-
other::r--

$ cd /root/accproof/xt && chmod g+s c && stat -c '%A %n' c
-rw-rwSr-- c

```

## §4 — Child datasets with ACLs off

```
### 4. child datasets with ACLs off under a share path; recursive named grant through the share door's 409

$ api POST /pools/testpool/datasets '{"path":"acc4"}'
HTTP 202
{
  "job": {
    "id": "dfa65868-742f-480d-9c0d-d90423566bcc",
    "status": "running",
    "operation": "zfs.create",
    "createdAt": "2026-10-11T22:28:59.101Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/dfa65868-742f-480d-9c0d-d90423566bcc   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "zfs.create",
  "progress": null,
  "result": {
    "created": "testpool/acc4"
  },
  "error": null
}

$ api POST /pools/testpool/datasets '{"path":"acc4/kid"}'
HTTP 202
{
  "job": {
    "id": "4644158b-9e52-4081-b56b-f5ba2f37989d",
    "status": "running",
    "operation": "zfs.create",
    "createdAt": "2026-10-11T22:28:59.517Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/4644158b-9e52-4081-b56b-f5ba2f37989d   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "zfs.create",
  "progress": null,
  "result": {
    "created": "testpool/acc4/kid"
  },
  "error": null
}

$ api POST /pools/testpool/datasets '{"path":"acc4/away","properties":{"mountpoint":"/accaway"}}'
HTTP 202
{
  "job": {
    "id": "f2815e6d-79fa-4d88-bcbb-d792278d03cb",
    "status": "running",
    "operation": "zfs.create",
    "createdAt": "2026-10-11T22:28:59.852Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/f2815e6d-79fa-4d88-bcbb-d792278d03cb   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "zfs.create",
  "progress": null,
  "result": {
    "created": "testpool/acc4/away"
  },
  "error": null
}

(the API's mountpoint is an absolute path; the legacy child is a shell fixture)
$ zfs create -o mountpoint=legacy testpool/acc4/leg

$ echo kid > /testpool/acc4/kid/kid.txt; echo away > /accaway/away.txt; echo top > /testpool/acc4/top.txt

$ zfs list -r -H -o name,mountpoint,acltype testpool/acc4
testpool/acc4	/testpool/acc4	off
testpool/acc4/away	/accaway	off
testpool/acc4/kid	/testpool/acc4/kid	off
testpool/acc4/leg	legacy	off

--- 4a. the create with applyToExisting, no confirm
$ api POST /shares/smb '{"name":"acc4","path":"/testpool/acc4","comment":"","browseable":true,"readOnly":false,"guestOk":false,"validUsers":["accuser"],"hostsAllow":[],"hostsDeny":[],"grantAccess":{"applyToExisting":true}}'
HTTP 409
X-Anas-Confirm-Code: 9d9e0d21c2d6
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Applying to existing files rewrites the permissions of every file and directory under '/testpool/acc4'",
    "warnings": [
      "It crosses the child datasets mounted under '/testpool/acc4': testpool/acc4/kid (/testpool/acc4/kid).",
      "POSIX ACLs (acltype=posixacl) are switched on first for testpool/acc4/kid, as for 'testpool/acc4' itself.",
      "The current permissions are not recorded anywhere, so this cannot be undone."
    ]
  }
}

--- nothing was written before the resend
$ api GET /shares/smb/acc4
HTTP 404
{
  "error": {
    "code": "NOT_FOUND",
    "message": "SMB share 'acc4' not found"
  }
}

$ grep -c '^\[acc4\]' /etc/samba/smb.conf
0

$ zfs list -r -H -o name,acltype testpool/acc4
testpool/acc4	off
testpool/acc4/away	off
testpool/acc4/kid	off
testpool/acc4/leg	off

--- 4b. resend with the code
$ api POST /shares/smb '{"name":"acc4","path":"/testpool/acc4","comment":"","browseable":true,"readOnly":false,"guestOk":false,"validUsers":["accuser"],"hostsAllow":[],"hostsDeny":[],"grantAccess":{"applyToExisting":true}}'   [X-Anas-Confirm: 9d9e0d21c2d6]
HTTP 202
{
  "job": {
    "id": "d64958ec-0a32-4ce6-a855-9380ba8eba64",
    "status": "running",
    "operation": "smb.share.add",
    "createdAt": "2026-10-11T22:29:00.892Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/d64958ec-0a32-4ce6-a855-9380ba8eba64   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.share.add",
  "progress": "chmod g+s /testpool/acc4",
  "result": {
    "created": "acc4",
    "grant": {
      "status": "applied",
      "path": "/testpool/acc4",
      "granted": [
        {
          "kind": "user",
          "name": "accuser",
          "level": "read-write"
        }
      ],
      "skipped": [],
      "applyToExisting": true,
      "childAclEnabled": [
        "testpool/acc4/kid"
      ]
    }
  },
  "error": null
}

$ zfs get -H -o name,property,value,source acltype,xattr testpool/acc4 testpool/acc4/kid testpool/acc4/away testpool/acc4/leg
testpool/acc4	acltype	posix	local
testpool/acc4	xattr	sa	local
testpool/acc4/away	acltype	posix	inherited from testpool/acc4
testpool/acc4/away	xattr	sa	inherited from testpool/acc4
testpool/acc4/kid	acltype	posix	local
testpool/acc4/kid	xattr	sa	local
testpool/acc4/leg	acltype	posix	inherited from testpool/acc4
testpool/acc4/leg	xattr	sa	inherited from testpool/acc4

$ getfacl -p /testpool/acc4/kid/kid.txt /testpool/acc4/kid
# file: /testpool/acc4/kid/kid.txt
# owner: root
# group: root
# flags: -s-
user::rwx
user:accuser:rwx
group::r-x
mask::rwx
other::r-x

# file: /testpool/acc4/kid
# owner: root
# group: root
# flags: -s-
user::rwx
user:accuser:rwx
group::r-x
mask::rwx
other::r-x
default:user::rwx
default:user:accuser:rwx
default:group::r-x
default:mask::rwx
default:other::r-x

$ getfacl -p /accaway/away.txt
# file: /accaway/away.txt
# owner: root
# group: root
user::rw-
group::r--
other::r--

$ smbclient //localhost/acc4 -U 'accuser%Acc-proof-1' -c 'cd kid; put /root/accproof/s1-put.txt from-smb.txt; ls'
putting file /root/accproof/s1-put.txt as \kid\from-smb.txt (13.7 kb/s) (average 13.7 kb/s)
  .                                   D        0  Sun Oct 11 22:29:02 2026
  ..                                  D        0  Sun Oct 11 22:29:00 2026
  from-smb.txt                        A       28  Sun Oct 11 22:29:02 2026
  kid.txt                             N        4  Sun Oct 11 22:29:00 2026

		1834496 blocks of size 1024. 1834368 blocks available

```

## §5 — AHR pool: the shared Permissions editor and an SMB share

```
### 5a. a small AHR-1 pool on the two blank fixture disks, through the API

$ api POST /ahr '{"name":"accahr","tier":"ahr1","disks":["scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT7","scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT8"]}'
HTTP 409
X-Anas-Confirm-Code: bf02e33116f5
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Creating AHR pool 'accahr' will WIPE 2 disk(s). All data on them will be permanently erased",
    "warnings": [
      "scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT7 (QEMU HARDDISK, 1 GiB) will be completely erased",
      "scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT8 (QEMU HARDDISK, 1 GiB) will be completely erased"
    ]
  }
}

$ api POST /ahr '{"name":"accahr","tier":"ahr1","disks":["scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT7","scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT8"]}'   [X-Anas-Confirm: bf02e33116f5]
HTTP 202
{
  "job": {
    "id": "90ff74dd-2db0-4264-8877-187566806259",
    "status": "running",
    "operation": "ahr.create",
    "createdAt": "2026-10-11T22:29:49.061Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/90ff74dd-2db0-4264-8877-187566806259   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "ahr.create",
  "progress": "Notifying PVE",
  "result": {
    "created": "accahr",
    "mountpoint": "/mnt/anas-ahr/accahr",
    "arrays": [
      "accahr-r1"
    ]
  },
  "error": null
}

$ api GET /ahr/accahr
HTTP 200
{
  "data": {
    "name": "accahr",
    "ahrType": "ahr1",
    "mountpoint": "/mnt/anas-ahr/accahr",
    "mounted": true,
    "mountedReadOnly": false,
    "disks": [
      {
        "id": "scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT7",
        "sizeBytes": 1073741824,
        "usableBytes": 1073741824,
        "model": "QEMU HARDDISK",
        "serial": "ANAS_HOT7",
        "role": "member",
        "partitions": [
          {
            "device": "/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT7-part1",
            "band": 1,
            "sizeBytes": 1072676352
          }
        ]
      },
      {
        "id": "scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT8",
        "sizeBytes": 1073741824,
        "usableBytes": 1073741824,
        "model": "QEMU HARDDISK",
        "serial": "ANAS_HOT8",
        "role": "member",
        "partitions": [
          {
            "device": "/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT8-part1",
            "band": 1,
            "sizeBytes": 1072676352
          }
        ]
      }
    ],
    "arrays": [
      {
        "device": "/dev/md/accahr-r1",
        "band": 1,
        "level": "raid1",
        "heightBytes": 1072676352,
        "members": [
          {
            "disk": "scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT8",
            "partition": "/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT8-part1",
            "memberState": "in_sync"
          },
          {
            "disk": "scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT7",
            "partition": "/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT7-part1",
            "memberState": "in_sync"
          }
        ],
        "state": "clean",
        "kernelName": "md127",
        "uuid": "295da3d3:3e1f352c:2822459c:0246e3cc"
      }
    ],
    "vg": {
      "name": "accahr",
      "sizeBytes": 1065353216,
      "freeBytes": 0,
      "uuid": "4zz3xe-Kudb-hP7r-qsaD-Lg1d-raTf-RasxI7"
    },
    "lv": {
      "name": "accahr-vol",
      "sizeBytes": 1065353216
    },
    "capacity": {
      "rawBytes": 2147483648,
      "usableBytes": 1065353216,
      "usedBytes": 360448,
      "freeBytes": 942145536,
      "redundancyOverheadBytes": 1076919296,
      "unprotectedWastedBytes": 5211136,
      "pendingBytes": 0
    },
    "state": "healthy",
    "subvolLayout": true,
    "cache": {
      "devices": [],
      "sizeBytes": 0,
      "mode": "writethrough",
      "policy": "",
      "state": "absent"
    },
    "advisories": []
  }
}

```

```
### 5b. the AHR Permissions editor: same shape, named grant, recursive sweep, no zfs set, @snapshots untouched

$ findmnt -n -o TARGET,SOURCE,FSTYPE,OPTIONS /mnt/anas-ahr/accahr
/mnt/anas-ahr/accahr /dev/mapper/accahr-accahr--vol[/@data] btrfs rw,relatime,discard=async,space_cache=v2,subvolid=256,subvol=/@data

$ stat -c '%U:%G %A %n' /mnt/anas-ahr/accahr; getfacl -p /mnt/anas-ahr/accahr
root:root drwxr-xr-x /mnt/anas-ahr/accahr
# file: /mnt/anas-ahr/accahr
# owner: root
# group: root
user::rwx
group::r-x
other::r-x

(fixtures: a file, and a subvolume with a file, under the mount)
$ echo top > /mnt/anas-ahr/accahr/top.txt && btrfs subvolume create /mnt/anas-ahr/accahr/sub1 && echo insub > /mnt/anas-ahr/accahr/sub1/insub.txt
Create subvolume '/mnt/anas-ahr/accahr/sub1'

$ api POST /ahr/accahr/snapshots '{"name":"accsnap"}'
HTTP 202
{
  "job": {
    "id": "c5b37f0c-a5f5-478e-8831-42ed67b05929",
    "status": "running",
    "operation": "ahr.snapshot.create",
    "createdAt": "2026-10-11T22:30:36.528Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/c5b37f0c-a5f5-478e-8831-42ed67b05929   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "ahr.snapshot.create",
  "progress": "Creating read-only snapshot @snapshots/accsnap",
  "result": {
    "pool": "accahr",
    "snapshot": "accsnap"
  },
  "error": null
}

$ mkdir -p /root/accproof/top && mount -o ro,subvolid=5 /dev/accahr/accahr-vol /root/accproof/top && ls /root/accproof/top /root/accproof/top/@snapshots && getfacl -p /root/accproof/top/@snapshots/accsnap/top.txt; umount /root/accproof/top
/root/accproof/top:
@data
@snapshots

/root/accproof/top/@snapshots:
accsnap
# file: /root/accproof/top/@snapshots/accsnap/top.txt
# owner: root
# group: root
user::rw-
group::r--
other::r--

$ for p in $(zpool list -H -o name); do zpool history $p | wc -l | sed "s|^|$p |"; done | tee /root/accproof/hist-before
accz 3
gtbackup 908
gtiscsi 66
pvfix 252
sysfix 10
testpool 325

--- the AHR GET and a ZFS dataset's GET carry the same keys (backing aside)
$ api GET /ahr/accahr/access
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
      }
    ],
    "aclText": "# file: /mnt/anas-ahr/accahr\n# owner: root\n# group: root\nuser::rwx\ngroup::r-x\nother::r-x\n\n",
    "backing": "ahr"
  }
}

$ python3 -c "import json; a=json.load(open('/root/accproof/ahr-get.json'))['data']; d=json.load(open('/root/accproof/ds-get.json'))['data']; print('ahr keys:', sorted(a)); print('dataset keys:', sorted(d)); print('entry keys ahr:', sorted({k for e in a['entries'] for k in e}), 'dataset:', sorted({k for e in d['entries'] for k in e}))"
ahr keys: ['aclEnabled', 'aclSupported', 'aclText', 'backing', 'entries', 'group', 'owner']
dataset keys: ['aclEnabled', 'aclSupported', 'aclText', 'entries', 'group', 'owner']
entry keys ahr: ['kind', 'level'] dataset: ['kind', 'level', 'name']

--- 5c. a named grant (the editor's body), not recursive
$ api PUT /ahr/accahr/access '{"owner":"root","group":"root","entries":[{"kind":"owner","level":"read-write"},{"kind":"owning-group","level":"read"},{"kind":"everyone","level":"read"},{"kind":"user","name":"accuser","level":"read-write"}],"applyToExisting":false}'
HTTP 202
{
  "job": {
    "id": "d710253f-f527-4471-a512-00e3eb4b80c0",
    "status": "running",
    "operation": "fs.setAccess",
    "createdAt": "2026-10-11T22:30:37.319Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/d710253f-f527-4471-a512-00e3eb4b80c0   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "fs.setAccess",
  "progress": "chmod g+s /mnt/anas-ahr/accahr",
  "result": {
    "pool": "accahr",
    "mountpoint": "/mnt/anas-ahr/accahr",
    "aclEnabled": true,
    "aclAutoEnabled": false,
    "namedCount": 1
  },
  "error": null
}

$ getfacl -p /mnt/anas-ahr/accahr
# file: /mnt/anas-ahr/accahr
# owner: root
# group: root
# flags: -s-
user::rwx
user:accuser:rwx
group::r-x
mask::rwx
other::r-x
default:user::rwx
default:user:accuser:rwx
default:group::r-x
default:mask::rwx
default:other::r-x

$ getfacl -p /mnt/anas-ahr/accahr/top.txt
# file: /mnt/anas-ahr/accahr/top.txt
# owner: root
# group: root
user::rw-
group::r--
other::r--

--- 5d. the recursive apply: 409 with the subvolume sentence, then the resend
$ api PUT /ahr/accahr/access '{"owner":"root","group":"root","entries":[{"kind":"owner","level":"read-write"},{"kind":"owning-group","level":"read"},{"kind":"everyone","level":"read"},{"kind":"user","name":"accuser","level":"read-write"}],"applyToExisting":true}'
HTTP 409
X-Anas-Confirm-Code: 52da9e8fbace
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Applying to existing files rewrites the permissions of every file and directory under '/mnt/anas-ahr/accahr'",
    "warnings": [
      "On a Hybrid RAID pool it sweeps every subvolume under the pool's data as one tree; the pool's snapshots are not touched.",
      "The current permissions are not recorded anywhere, so this cannot be undone."
    ]
  }
}

$ api PUT /ahr/accahr/access '{"owner":"root","group":"root","entries":[{"kind":"owner","level":"read-write"},{"kind":"owning-group","level":"read"},{"kind":"everyone","level":"read"},{"kind":"user","name":"accuser","level":"read-write"}],"applyToExisting":true}'   [X-Anas-Confirm: 52da9e8fbace]
HTTP 202
{
  "job": {
    "id": "a94a731b-1380-4f98-a3af-c79d43242343",
    "status": "running",
    "operation": "fs.setAccess",
    "createdAt": "2026-10-11T22:30:38.049Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/a94a731b-1380-4f98-a3af-c79d43242343   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "fs.setAccess",
  "progress": "chmod g+s /mnt/anas-ahr/accahr",
  "result": {
    "pool": "accahr",
    "mountpoint": "/mnt/anas-ahr/accahr",
    "aclEnabled": true,
    "aclAutoEnabled": false,
    "namedCount": 1
  },
  "error": null
}

$ getfacl -p /mnt/anas-ahr/accahr/top.txt /mnt/anas-ahr/accahr/sub1/insub.txt
# file: /mnt/anas-ahr/accahr/top.txt
# owner: root
# group: root
# flags: -s-
user::rwx
user:accuser:rwx
group::r-x
mask::rwx
other::r-x

# file: /mnt/anas-ahr/accahr/sub1/insub.txt
# owner: root
# group: root
# flags: -s-
user::rwx
user:accuser:rwx
group::r-x
mask::rwx
other::r-x

$ mount -o ro,subvolid=5 /dev/accahr/accahr-vol /root/accproof/top && getfacl -p /root/accproof/top/@snapshots/accsnap/top.txt /root/accproof/top/@snapshots/accsnap; umount /root/accproof/top
# file: /root/accproof/top/@snapshots/accsnap/top.txt
# owner: root
# group: root
user::rw-
group::r--
other::r--

# file: /root/accproof/top/@snapshots/accsnap
# owner: root
# group: root
user::rwx
group::r-x
other::r-x

$ for p in $(zpool list -H -o name); do zpool history $p | wc -l | sed "s|^|$p |"; done > /root/accproof/hist-after; diff /root/accproof/hist-before /root/accproof/hist-after && echo 'zpool history: no new entries on any pool'
zpool history: no new entries on any pool

$ journalctl -u anasd --since '-3min' --no-pager -o cat | grep '"audit":true' | grep -E 'ahr.setAccess|fs.setAccess' | python3 -c "import sys,json; [print(json.dumps({k:j[k] for k in ('event','operation','params')})) for j in map(json.loads, sys.stdin)]"
{"event": "job.submitted", "operation": "fs.setAccess", "params": {"share": "accz", "path": "/accz", "ownerChanged": false, "groupChanged": false, "baseChanged": true, "namedCount": 2, "preservedNamedCount": 0, "clearNamed": false, "applyToExisting": true, "aclAutoEnabled": false}}
{"event": "job.completed", "operation": "fs.setAccess", "params": {"share": "accz", "path": "/accz", "ownerChanged": false, "groupChanged": false, "baseChanged": true, "namedCount": 2, "preservedNamedCount": 0, "clearNamed": false, "applyToExisting": true, "aclAutoEnabled": false}}
{"event": "job.submitted", "operation": "fs.setAccess", "params": {"share": "accz", "path": "/accz", "ownerChanged": false, "groupChanged": false, "baseChanged": true, "namedCount": 2, "preservedNamedCount": 0, "clearNamed": false, "applyToExisting": false, "aclAutoEnabled": false}}
{"event": "job.completed", "operation": "fs.setAccess", "params": {"share": "accz", "path": "/accz", "ownerChanged": false, "groupChanged": false, "baseChanged": true, "namedCount": 2, "preservedNamedCount": 0, "clearNamed": false, "applyToExisting": false, "aclAutoEnabled": false}}
{"event": "job.submitted", "operation": "fs.setAccess", "params": {"pool": "accahr", "mountpoint": "/mnt/anas-ahr/accahr", "ownerChanged": false, "groupChanged": false, "baseChanged": true, "namedCount": 1, "preservedNamedCount": 0, "clearNamed": false, "applyToExisting": false, "aclAutoEnabled": false}}
{"event": "job.completed", "operation": "fs.setAccess", "params": {"pool": "accahr", "mountpoint": "/mnt/anas-ahr/accahr", "ownerChanged": false, "groupChanged": false, "baseChanged": true, "namedCount": 1, "preservedNamedCount": 0, "clearNamed": false, "applyToExisting": false, "aclAutoEnabled": false}}
{"event": "job.submitted", "operation": "fs.setAccess", "params": {"pool": "accahr", "mountpoint": "/mnt/anas-ahr/accahr", "ownerChanged": false, "groupChanged": false, "baseChanged": true, "namedCount": 1, "preservedNamedCount": 0, "clearNamed": false, "applyToExisting": true, "aclAutoEnabled": false}}
{"event": "job.completed", "operation": "fs.setAccess", "params": {"pool": "accahr", "mountpoint": "/mnt/anas-ahr/accahr", "ownerChanged": false, "groupChanged": false, "baseChanged": true, "namedCount": 1, "preservedNamedCount": 0, "clearNamed": false, "applyToExisting": true, "aclAutoEnabled": false}}

```

```
### 5e. SMB share on the AHR pool to a named user (accuser2, not yet on the path), grant ON

$ api POST /shares/smb '{"name":"accahr","path":"/mnt/anas-ahr/accahr","comment":"","browseable":true,"readOnly":false,"guestOk":false,"validUsers":["accuser2"],"hostsAllow":[],"hostsDeny":[],"grantAccess":{}}'
HTTP 202
{
  "job": {
    "id": "51bdf3e3-0a69-4d58-9384-91c31374568d",
    "status": "running",
    "operation": "smb.share.add",
    "createdAt": "2026-10-11T22:30:49.522Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/51bdf3e3-0a69-4d58-9384-91c31374568d   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.share.add",
  "progress": "chmod g+s /mnt/anas-ahr/accahr",
  "result": {
    "created": "accahr",
    "grant": {
      "status": "applied",
      "path": "/mnt/anas-ahr/accahr",
      "granted": [
        {
          "kind": "user",
          "name": "accuser2",
          "level": "read-write"
        }
      ],
      "skipped": [],
      "applyToExisting": false
    }
  },
  "error": null
}

$ getfacl -p /mnt/anas-ahr/accahr
# file: /mnt/anas-ahr/accahr
# owner: root
# group: root
# flags: -s-
user::rwx
user:accuser:rwx
user:accuser2:rwx
group::r-x
mask::rwx
other::r-x
default:user::rwx
default:user:accuser:rwx
default:user:accuser2:rwx
default:group::r-x
default:mask::rwx
default:other::r-x

$ smbclient //localhost/accahr -U 'accuser2%Acc-proof-2' -c 'put /root/accproof/s1-put.txt ahr-put.txt; cd sub1; put /root/accproof/s1-put.txt ahr-sub-put.txt; ls'
putting file /root/accproof/s1-put.txt as \ahr-put.txt (5.5 kb/s) (average 5.5 kb/s)
NT_STATUS_ACCESS_DENIED opening remote file \sub1\ahr-sub-put.txt
  .                                   D        0  Sun Oct 11 22:30:36 2026
  ..                                  D        0  Sun Oct 11 22:30:50 2026
  insub.txt                           N        6  Sun Oct 11 22:30:36 2026

		1040384 blocks of size 1024. 919040 blocks available

$ stat -c '%U:%G %A %n' /mnt/anas-ahr/accahr/ahr-put.txt /mnt/anas-ahr/accahr/sub1/ahr-sub-put.txt
accuser2:root -rwxr--r-- /mnt/anas-ahr/accahr/ahr-put.txt
stat: cannot statx '/mnt/anas-ahr/accahr/sub1/ahr-sub-put.txt': No such file or directory

$ api GET /shares/smb/accahr/access
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
        "name": "accuser",
        "level": "read-write"
      },
      {
        "kind": "user",
        "name": "accuser2",
        "level": "read-write"
      }
    ],
    "aclText": "# file: /mnt/anas-ahr/accahr\n# owner: root\n# group: root\n# flags: -s-\nuser::rwx\nuser:accuser:rwx\nuser:accuser2:rwx\ngroup::r-x\nmask::rwx\nother::r-x\ndefault:user::rwx\ndefault:user:accuser:rwx\ndefault:user:accuser2:rwx\ndefault:group::r-x\ndefault:mask::rwx\ndefault:other::r-x\n\n",
    "backing": "ahr"
  }
}

```

In 5b the journald window (`--since '-3min'`) also caught §3's two `accz` jobs; the AHR ones are
the four lines with `"pool": "accahr"`, and their params carry `aclAutoEnabled: false`. In 5e
accuser2's write into `sub1` is refused because the share's grant is not recursive and `sub1`
existed before it (the dialog's "existing files keep their permissions unless applied").

## §6 — PVE-owned paths

```
### 6. PVE-owned paths

$ grep -A3 -E '^(zfspool: pvfix|dir: local)$' /etc/pve/storage.cfg
dir: local
	path /var/lib/vz
	content iso,vztmpl,images,rootdir,backup,snippets
	prune-backups keep-all=1
--
zfspool: pvfix
	pool pvfix
	content rootdir,images
	mountpoint /pvfix

--- 6a. the pvfix zfspool storage root: share create refuses before anything (pvepool.1)
$ getfacl -p /pvfix
# file: /pvfix
# owner: root
# group: root
user::rwx
group::r-x
other::r-x

$ api POST /shares/smb '{"name":"accpvfix","path":"/pvfix","comment":"","browseable":true,"readOnly":false,"guestOk":false,"validUsers":["accuser"],"hostsAllow":[],"hostsDeny":[],"grantAccess":{}}'
HTTP 400
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Share path '/pvfix' is on 'pvfix', which is PVE-owned \u2014 PVE storage 'pvfix' owns pvfix as a storage root"
  }
}

$ grep -c '^\[accpvfix\]' /etc/samba/smb.conf; getfacl -p /pvfix
0
# file: /pvfix
# owner: root
# group: root
user::rwx
group::r-x
other::r-x

--- 6b. a non-ZFS directory inside the 'local' dir storage (/var/lib/vz): share created, grant refused
$ mkdir /var/lib/vz/accpve && getfacl -p /var/lib/vz/accpve
# file: /var/lib/vz/accpve
# owner: root
# group: root
user::rwx
group::r-x
other::r-x

$ api POST /shares/smb '{"name":"accvz","path":"/var/lib/vz/accpve","comment":"","browseable":true,"readOnly":false,"guestOk":false,"validUsers":["accuser"],"hostsAllow":[],"hostsDeny":[],"grantAccess":{}}'
HTTP 202
{
  "job": {
    "id": "12952a20-7e68-40df-aa9e-63a34d452291",
    "status": "running",
    "operation": "smb.share.add",
    "createdAt": "2026-10-11T22:31:29.750Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/12952a20-7e68-40df-aa9e-63a34d452291   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.share.add",
  "progress": null,
  "result": {
    "created": "accvz",
    "grant": {
      "status": "refused",
      "path": "/var/lib/vz/accpve",
      "granted": [],
      "skipped": [],
      "applyToExisting": false,
      "message": "'/var/lib/vz/accpve' is inside '/var/lib/vz', the path of PVE storage 'local' \u2014 its permissions are PVE's to manage"
    }
  },
  "error": null
}

$ testparm -s --section-name=accvz 2>/dev/null; getfacl -p /var/lib/vz/accpve

[accvz]
	path = /var/lib/vz/accpve
	read only = No
	valid users = accuser
# file: /var/lib/vz/accpve
# owner: root
# group: root
user::rwx
group::r-x
other::r-x

--- 6c. a recursive grant on a non-ZFS directory with a dir storage inside it (throwaway storage 'accpvestore')
$ mkdir -p /srv/accpve/store && echo old > /srv/accpve/old.txt && pvesm add dir accpvestore --path /srv/accpve/store --content backup && grep -A2 '^dir: accpvestore' /etc/pve/storage.cfg
dir: accpvestore
	path /srv/accpve/store
	content backup

$ getfacl -p /srv/accpve /srv/accpve/old.txt
# file: /srv/accpve
# owner: root
# group: root
user::rwx
group::r-x
other::r-x

# file: /srv/accpve/old.txt
# owner: root
# group: root
user::rw-
group::r--
other::r--

$ api POST /shares/smb '{"name":"accsrv","path":"/srv/accpve","comment":"","browseable":true,"readOnly":false,"guestOk":false,"validUsers":["accuser"],"hostsAllow":[],"hostsDeny":[],"grantAccess":{"applyToExisting":true}}'
HTTP 409
X-Anas-Confirm-Code: 8cc17cce32a8
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Applying to existing files rewrites the permissions of every file and directory under '/srv/accpve'",
    "warnings": [
      "The current permissions are not recorded anywhere, so this cannot be undone."
    ]
  }
}

$ api POST /shares/smb '{"name":"accsrv","path":"/srv/accpve","comment":"","browseable":true,"readOnly":false,"guestOk":false,"validUsers":["accuser"],"hostsAllow":[],"hostsDeny":[],"grantAccess":{"applyToExisting":true}}'   [X-Anas-Confirm: 8cc17cce32a8]
HTTP 202
{
  "job": {
    "id": "b34bf420-e94b-49df-9224-d9e6f508a9c8",
    "status": "running",
    "operation": "smb.share.add",
    "createdAt": "2026-10-11T22:31:32.014Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/b34bf420-e94b-49df-9224-d9e6f508a9c8   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.share.add",
  "progress": null,
  "result": {
    "created": "accsrv",
    "grant": {
      "status": "refused",
      "path": "/srv/accpve",
      "granted": [],
      "skipped": [],
      "applyToExisting": true,
      "message": "Recursive permission change of '/srv/accpve' would include /srv/accpve/store \u2014 the path of PVE storage 'accpvestore'"
    }
  },
  "error": null
}

$ testparm -s --section-name=accsrv 2>/dev/null; getfacl -p /srv/accpve /srv/accpve/old.txt

[accsrv]
	path = /srv/accpve
	read only = No
	valid users = accuser
# file: /srv/accpve
# owner: root
# group: root
user::rwx
group::r-x
other::r-x

# file: /srv/accpve/old.txt
# owner: root
# group: root
user::rw-
group::r--
other::r--

--- 6d. the same directory through the editor door, recursive
$ api PUT /shares/smb/accsrv/access '{"owner":"root","group":"root","entries":[{"kind":"owner","level":"read-write"},{"kind":"owning-group","level":"read"},{"kind":"everyone","level":"read"},{"kind":"user","name":"accuser","level":"read-write"}],"applyToExisting":true}'
HTTP 400
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Recursive permission change of '/srv/accpve' would include /srv/accpve/store \u2014 the path of PVE storage 'accpvestore'"
  }
}

```

## §8 — Teardown and node health

```
### 8. teardown, through the API where ANAS made it; shell only for the shell-made fixtures

$ api DELETE /shares/smb/accz
HTTP 409
X-Anas-Confirm-Code: bb9390418e4b
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Removing SMB share 'accz' stops sharing '/accz'",
    "warnings": [
      "Removing SMB share 'accz' makes the shared path '/accz' inaccessible over SMB."
    ]
  }
}

$ api DELETE /shares/smb/accz   [X-Anas-Confirm: bb9390418e4b]
HTTP 202
{
  "job": {
    "id": "d9cd31f7-7d19-4d54-b881-8d257a8e8590",
    "status": "running",
    "operation": "smb.share.remove",
    "createdAt": "2026-10-11T22:32:11.933Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/d9cd31f7-7d19-4d54-b881-8d257a8e8590   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.share.remove",
  "progress": null,
  "result": {
    "removed": "accz"
  },
  "error": null
}

$ api DELETE /shares/smb/accguest
HTTP 409
X-Anas-Confirm-Code: e0c23044409e
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Removing SMB share 'accguest' stops sharing '/testpool/accguest'",
    "warnings": [
      "Removing SMB share 'accguest' makes the shared path '/testpool/accguest' inaccessible over SMB."
    ]
  }
}

$ api DELETE /shares/smb/accguest   [X-Anas-Confirm: e0c23044409e]
HTTP 202
{
  "job": {
    "id": "f2ee246f-874c-44af-a515-1a747016550d",
    "status": "running",
    "operation": "smb.share.remove",
    "createdAt": "2026-10-11T22:32:12.287Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/f2ee246f-874c-44af-a515-1a747016550d   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.share.remove",
  "progress": null,
  "result": {
    "removed": "accguest"
  },
  "error": null
}

$ api DELETE /shares/smb/acc4
HTTP 409
X-Anas-Confirm-Code: 00f343663608
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Removing SMB share 'acc4' stops sharing '/testpool/acc4'",
    "warnings": [
      "Removing SMB share 'acc4' makes the shared path '/testpool/acc4' inaccessible over SMB."
    ]
  }
}

$ api DELETE /shares/smb/acc4   [X-Anas-Confirm: 00f343663608]
HTTP 202
{
  "job": {
    "id": "9a3abcdb-b226-406e-a315-039ecb31b339",
    "status": "running",
    "operation": "smb.share.remove",
    "createdAt": "2026-10-11T22:32:12.607Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/9a3abcdb-b226-406e-a315-039ecb31b339   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.share.remove",
  "progress": null,
  "result": {
    "removed": "acc4"
  },
  "error": null
}

$ api DELETE /shares/smb/accahr
HTTP 409
X-Anas-Confirm-Code: 744df6cea9f2
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Removing SMB share 'accahr' stops sharing '/mnt/anas-ahr/accahr'",
    "warnings": [
      "Removing SMB share 'accahr' makes the shared path '/mnt/anas-ahr/accahr' inaccessible over SMB."
    ]
  }
}

$ api DELETE /shares/smb/accahr   [X-Anas-Confirm: 744df6cea9f2]
HTTP 202
{
  "job": {
    "id": "8cb6be3f-bfe2-4dd2-a369-0bf28e82fa3d",
    "status": "running",
    "operation": "smb.share.remove",
    "createdAt": "2026-10-11T22:32:13.017Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/8cb6be3f-bfe2-4dd2-a369-0bf28e82fa3d   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.share.remove",
  "progress": null,
  "result": {
    "removed": "accahr"
  },
  "error": null
}

$ api DELETE /shares/smb/accvz
HTTP 409
X-Anas-Confirm-Code: 902133348229
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Removing SMB share 'accvz' stops sharing '/var/lib/vz/accpve'",
    "warnings": [
      "Removing SMB share 'accvz' makes the shared path '/var/lib/vz/accpve' inaccessible over SMB."
    ]
  }
}

$ api DELETE /shares/smb/accvz   [X-Anas-Confirm: 902133348229]
HTTP 202
{
  "job": {
    "id": "39cef21d-fa85-4ad5-acd9-1b1778144d07",
    "status": "running",
    "operation": "smb.share.remove",
    "createdAt": "2026-10-11T22:32:13.367Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/39cef21d-fa85-4ad5-acd9-1b1778144d07   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.share.remove",
  "progress": null,
  "result": {
    "removed": "accvz"
  },
  "error": null
}

$ api DELETE /shares/smb/accsrv
HTTP 409
X-Anas-Confirm-Code: eb6d4293a263
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Removing SMB share 'accsrv' stops sharing '/srv/accpve'",
    "warnings": [
      "Removing SMB share 'accsrv' makes the shared path '/srv/accpve' inaccessible over SMB."
    ]
  }
}

$ api DELETE /shares/smb/accsrv   [X-Anas-Confirm: eb6d4293a263]
HTTP 202
{
  "job": {
    "id": "851c40b8-08aa-46a0-8f80-289c55c8a874",
    "status": "running",
    "operation": "smb.share.remove",
    "createdAt": "2026-10-11T22:32:13.795Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/851c40b8-08aa-46a0-8f80-289c55c8a874   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "smb.share.remove",
  "progress": null,
  "result": {
    "removed": "accsrv"
  },
  "error": null
}

$ grep -cE '^\[(accz|accguest|acc4|accahr|accvz|accsrv)\]' /etc/samba/smb.conf
0

--- the grant is never revoked by deleting a share (access.1): the ACL on /accz is as the shares left it
$ getfacl -p /accz | grep -E '^(user|default:user):acc'
user:accuser:rwx
user:accuser2:rwx
default:user:accuser:rwx
default:user:accuser2:rwx

$ api DELETE /ahr/accahr
HTTP 409
X-Anas-Confirm-Code: fbc94e28af1d
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Destroying AHR pool 'accahr' erases all of its data",
    "warnings": [
      "Pool 'accahr' (0.99 GiB usable) will be permanently destroyed. Every array, partition, and all data is erased",
      "The filesystem at '/mnt/anas-ahr/accahr' will be unmounted: anything serving from it (shares, backups, mounts) stops working"
    ]
  }
}

$ api DELETE /ahr/accahr   [X-Anas-Confirm: fbc94e28af1d]
HTTP 202
{
  "job": {
    "id": "78dca6ba-352c-4877-8ce7-4413fc86a052",
    "status": "running",
    "operation": "ahr.destroy",
    "createdAt": "2026-10-11T22:32:14.327Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/78dca6ba-352c-4877-8ce7-4413fc86a052   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "ahr.destroy",
  "progress": "Clearing the expansion record",
  "result": {
    "destroyed": "accahr"
  },
  "error": null
}

$ api DELETE /pools/accz
HTTP 409
X-Anas-Confirm-Code: eaf338e09a53
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Destroying pool 'accz' permanently erases all its data",
    "warnings": [
      "Destroying 'accz' is irreversible \u2014 all data in the pool is permanently lost.",
      "Every dataset, snapshot, and volume in 'accz' will be destroyed."
    ]
  }
}

$ api DELETE /pools/accz   [X-Anas-Confirm: eaf338e09a53]
HTTP 202
{
  "job": {
    "id": "81725330-98ee-4f6d-82e7-1e184361194d",
    "status": "running",
    "operation": "zpool.destroy",
    "createdAt": "2026-10-11T22:32:28.791Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/81725330-98ee-4f6d-82e7-1e184361194d   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "zpool.destroy",
  "progress": null,
  "result": {
    "destroyed": "accz"
  },
  "error": null
}

$ api DELETE /pools/testpool/datasets/acc4?recursive=true
HTTP 409
X-Anas-Confirm-Code: cae99014db26
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Destroying dataset 'testpool/acc4' permanently erases its data",
    "warnings": [
      "Destroying 'testpool/acc4' is irreversible \u2014 all data in the dataset is permanently lost.",
      "3 child dataset(s) will also be destroyed."
    ]
  }
}

$ api DELETE /pools/testpool/datasets/acc4?recursive=true   [X-Anas-Confirm: cae99014db26]
HTTP 202
{
  "job": {
    "id": "619f86c5-dd72-4d31-b7e2-7d8fbc99531a",
    "status": "running",
    "operation": "zfs.destroy",
    "createdAt": "2026-10-11T22:32:30.543Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/619f86c5-dd72-4d31-b7e2-7d8fbc99531a   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "zfs.destroy",
  "progress": null,
  "result": {
    "destroyed": "testpool/acc4"
  },
  "error": null
}

$ api DELETE /pools/testpool/datasets/accguest
HTTP 409
X-Anas-Confirm-Code: 8c07fdd391b1
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Destroying dataset 'testpool/accguest' permanently erases its data",
    "warnings": [
      "Destroying 'testpool/accguest' is irreversible \u2014 all data in the dataset is permanently lost."
    ]
  }
}

$ api DELETE /pools/testpool/datasets/accguest   [X-Anas-Confirm: 8c07fdd391b1]
HTTP 202
{
  "job": {
    "id": "105f7d44-9e5c-4df4-b175-196bb8ac58e8",
    "status": "running",
    "operation": "zfs.destroy",
    "createdAt": "2026-10-11T22:32:32.316Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/105f7d44-9e5c-4df4-b175-196bb8ac58e8   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "zfs.destroy",
  "progress": null,
  "result": {
    "destroyed": "testpool/accguest"
  },
  "error": null
}

$ api DELETE /identity/users/accuser
HTTP 409
X-Anas-Confirm-Code: c014bf8d7c7b
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Deleting share user 'accuser' removes the account",
    "warnings": [
      "User 'accuser' (uid 1004) will be removed from the system",
      "Files owned by the user keep their uid (1004) \u2014 ownership is not changed, and a later user with the same uid would own them",
      "Its SMB password entry will be removed"
    ]
  }
}

$ api DELETE /identity/users/accuser   [X-Anas-Confirm: c014bf8d7c7b]
HTTP 202
{
  "job": {
    "id": "c8c52b25-3a5e-4bd8-bd4b-d4396e6f6b41",
    "status": "running",
    "operation": "identity.user.delete",
    "createdAt": "2026-10-11T22:32:33.766Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/c8c52b25-3a5e-4bd8-bd4b-d4396e6f6b41   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "identity.user.delete",
  "progress": "Deleting share user 'accuser'",
  "result": {
    "deleted": "accuser",
    "smbEntryRemoved": true
  },
  "error": null
}

$ api DELETE /identity/users/accuser2
HTTP 409
X-Anas-Confirm-Code: 61959e320d40
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Deleting share user 'accuser2' removes the account",
    "warnings": [
      "User 'accuser2' (uid 1005) will be removed from the system",
      "Files owned by the user keep their uid (1005) \u2014 ownership is not changed, and a later user with the same uid would own them",
      "Its SMB password entry will be removed"
    ]
  }
}

$ api DELETE /identity/users/accuser2   [X-Anas-Confirm: 61959e320d40]
HTTP 202
{
  "job": {
    "id": "d657f9d1-6dd6-44d2-8a7b-048a9556a7d4",
    "status": "running",
    "operation": "identity.user.delete",
    "createdAt": "2026-10-11T22:32:35.190Z",
    "createdBy": "root"
  }
}

$ api GET /jobs/d657f9d1-6dd6-44d2-8a7b-048a9556a7d4   (polled until done; status, operation, last progress, result, error)
{
  "status": "completed",
  "operation": "identity.user.delete",
  "progress": "Deleting share user 'accuser2'",
  "result": {
    "deleted": "accuser2",
    "smbEntryRemoved": true
  },
  "error": null
}

$ pvesm remove accpvestore && rm -rf /srv/accpve /var/lib/vz/accpve && rmdir /accaway 2>/dev/null; ls -d /accaway /srv/accpve /var/lib/vz/accpve /accz 2>&1
ls: cannot access '/accaway': No such file or directory
ls: cannot access '/srv/accpve': No such file or directory
ls: cannot access '/var/lib/vz/accpve': No such file or directory
ls: cannot access '/accz': No such file or directory

$ zpool list -H -o name; zfs list -r -H -o name,acltype testpool
gtbackup
gtiscsi
pvfix
sysfix
testpool
testpool	off
testpool/share1	off

$ id accuser accuser2 2>&1; pdbedit -L | grep -c '^accuser'
id: ‘accuser’: no such user
id: ‘accuser2’: no such user
0

$ lvs accahr 2>&1; ls /dev/md/ 2>&1; grep -c accahr /etc/fstab
  Volume group "accahr" not found
  Cannot process volume group accahr
ls: cannot access '/dev/md/': No such file or directory
0

```

```
### 8b. node health after teardown

$ systemctl is-active anasd anas smbd; systemctl show -p NRestarts --value anasd
active
active
active
0

$ curl -s --unix-socket /run/anas/anasd.sock http://localhost/v1/health; echo
{"status":"ok","version":"0.4.2"}

$ api GET /health
HTTP 200
{
  "status": "ok",
  "version": "0.4.2"
}

$ lsblk -d -o NAME,SIZE,SERIAL | grep -c ANAS_HOT; ls /dev/disk/by-id | grep -E 'HOT(7|8|9)' | wc -l
2
0

$ echo anasd active since: Sun 2026-10-11 22:23:15 UTC
anasd active since: Sun 2026-10-11 22:23:15 UTC

$ journalctl -u anasd --since 'Sun 2026-10-11 22:23:15 UTC' --no-pager -o cat | grep -E '"level":(40|50|60)' | wc -l
0

$ journalctl -u anas --since 'Sun 2026-10-11 22:23:15 UTC' --no-pager -p warning -o cat | grep -v '\[auth\] Using pve auth provider' | wc -l
0

$ testparm -s 2>&1 >/dev/null | grep -iE 'error|warn|unknown' | sort | uniq -c

$ rm -rf /root/accproof

```

In 8b the gateway count leaves out its own start-up line `[auth] Using pve auth provider`, which it writes with `console.warn`.
