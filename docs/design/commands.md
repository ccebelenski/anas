# The anasd command whitelist

## anasd Command Whitelist

anasd does NOT accept arbitrary commands. It maps structured operations to specific executables:

### ZFS Operations
| Operation | Command |
|-----------|---------|
| `zpool.list` | `zpool list -Hp` |
| `zpool.status` | `zpool status -p` |
| `zpool.create` | `zpool create [opts] <name> <vdevs...>` |
| `zpool.destroy` | `zpool destroy <name>` |
| `zpool.scrub` | `zpool scrub <name>` |
| `zpool.trim` | `zpool trim <name>` / `zpool trim -c <name>` (cancel) — Epic 4.12 |
| `zpool.upgrade` | `zpool upgrade <name>` (enable feature flags; one-way) — Epic 4.12 |
| `zpool.set` | `zpool set <prop>=<val> <name>` |
| `zpool.add` | `zpool add <name> <vdev-spec...>` |
| `zpool.remove` | `zpool remove <name> <vdev>` (cache/log/spare only — story vdevs.2) |
| `zpool.attach` | `zpool attach <name> <device> <new-device>` |
| `zpool.replace` | `zpool replace <name> <old-device> <new-device>` |
| `zpool.import` | `zpool import [opts]` |
| `zpool.export` | `zpool export <name>` |
| `zpool.import-unit` | `systemctl enable\|disable zfs-import@<escaped-pool>.service` (boot-import; side effect of create/import/destroy) |
| `disk.wipe` | `wipefs -a --force <device>` (optional cleanup after pool destroy) |
| `zfs.list` | `zfs list -j -p -r -o <props> -t filesystem,volume -- <pool>` (JSON — Principle 13, matches the pool parsers; snapshot listings take `-t snapshot`; `-j` needs ZFS 2.3+ — the code never runs `-t all`) |
| `zfs.create` | `zfs create [opts] <dataset>` |
| `zfs.destroy` | `zfs destroy <dataset>` |
| `zfs.set` | `zfs set <prop>=<val> <dataset>` |
| `zfs.get` | `zfs get -j <props> <dataset>` (JSON) |
| `zfs.snapshot` | `zfs snapshot <dataset>@<name>` |
| `zfs.rollback` | `zfs rollback <snapshot>` |
| `zfs.clone` | `zfs clone <snapshot> <target-dataset>` — Epic 5.7 |

> **Boot import (issue #22):** `/etc/zfs/zpool.cache` alone is not a reliable boot import on PVE — a pool can simply be missing after a reboot. Creating or importing a pool therefore also enables its `zfs-import@<pool>.service`, and destroying one disables it, exactly as PVE does in `PVE/API2/Disks/ZFS.pm` (their fix for Proxmox bug #2554). The instance name is systemd-escaped in-process (no `systemd-escape` shell-out). It is a **side effect of the mutation**, not an API call, and best-effort: the pool operation has already succeeded, so a `systemctl` failure is reported as a job warning rather than failing the job.

> **Associated shares (Epic 4.4):** a dataset's detail lists SMB/NFS shares serving its mountpoint by matching the mountpoint against `smb.conf` share paths and `/etc/exports` paths (read-only; reuses the share parsers). The same lookup feeds the destroy-confirmation warnings.

### Filesystem permissions (dataset mountpoints — Epic 4.7, POSIX MVP)
| Operation | Command |
|-----------|---------|
| `fs.chown` | `chown <owner>[:<group>] <mountpoint>` |
| `fs.chmod` | `chmod <mode> <mountpoint>` |
| `identity.users` | `getent passwd` (owner/group pickers — via nsswitch, NOT /etc/passwd; source-agnostic) |
| `identity.groups` | `getent group` |

### Layered access / ACLs (dataset mountpoints — Epic 4.7.2, POSIX ACLs)

The base three principals (owner / owning-group / everyone) are **mode bits** (`chown`/`chmod`); extra named principals are **POSIX ACL entries**. A named entry requires the `acl` package (feature-detected — if `setfacl` is absent, the base editor still works and named grants are disabled with an "install acl" hint) AND `acltype=posixacl` on the dataset (auto-enabled on first named grant, with a notice). Granting a principal also writes a matching **default ACL** (+ setgid on the dir) so new files inherit; `applyToExisting` recurses. Level → perms: none=`---`, read=`r-x`/`X`, read-write=`rwx`. Mask is managed so the reported group level stays truthful.

**Destruction is explicit, never inferred.** A `SetAccessRequest` whose `entries` list carries no named user/group row means "I am not changing the named grants" — the daemon preserves them (restating them in the declarative `setfacl --set`, which is also the only correct way to move the base levels on an ACL'd directory: a plain `chmod` writes the ACL *mask*, not `group::`). Named entries are removed only for `clearNamed: true`, which may not be combined with named entries. This is the contract for any list-valued field whose emptiness would destroy data: a client that failed to pre-fill itself produces the same empty list as a deliberate one, so absence can never carry intent. Likewise, when `acltype` is `posixacl` but `getfacl` cannot be read, `GET .../access` reports `aclEnabled: false` with `aclDegraded: true` rather than presenting mode-bit guesses as a healthy ACL.

| Operation | Command |
|-----------|---------|
| `fs.acl.get` | `getfacl -pcE <mountpoint>` (and `getfacl` on a probe for feature-detect) |
| `fs.acl.set` | `setfacl -m <spec>[,…] <mountpoint>` (access + `-d` default entries); a recursive apply runs the same specs through the walk helper, never `-R` |
| `fs.acl.clear` | `setfacl -b -k <mountpoint>` (remove access + default ACLs; recursive through the walk helper) — **explicit `clearNamed: true` only** |
| `fs.acltype.enable` | `zfs set acltype=posixacl xattr=sa <dataset>` (first named grant only; a recursive named grant also runs it first on each child dataset mounted under the path that has ACLs off) |
| `fs.acltype.children` | `zfs list -r -H -o name,mountpoint,acltype <dataset>` (recursive named grant only — the children the walk crosses) |
| `fs.acltype.get` | `zfs get -Hp -o value acltype <dataset>` |

**One writer, three targets (access.1/access.2, 2026-10-11).** The editor lives in `services/access.ts`; the datasets routes, `GET/PUT /v1/ahr/:name/access` and the share routes' `…/access` all call it, and the share-path grant is the same writer with the form pre-filled (guest access counts only when the stanza's `valid users` is empty — Samba admits no guest otherwise; the result carries `guestNote`). A target resolver names the directory — ZFS dataset or pool root (its mountpoint), AHR pool (the mounted `@data`), or a share path (resolved onto its home by the self-service resolver: ZFS dataset, AHR pool, or neither) — and is the one place the filesystems differ: **the ACL switch** — `acltype` exists only on ZFS (`fs.acltype.*` run only for a ZFS home; btrfs and other Linux filesystems have POSIX ACLs natively, so `aclEnabled` needs no switch and nothing is ever `zfs set` on a non-ZFS target); **the recursive walk** — never crosses a mount boundary it did not name (nf.1, wave-3 node pass D2: a `chown -R` walked into an NFS mount below a dataset and rewrote the NFS server's export). Every recursive apply is ONE run of the walk helper `anas-acl-walk.pl` (`/usr/bin/perl <script>`, shipped beside the daemon's compiled services; the job as one JSON object on stdin, the walk roots opened and proven by the daemon and inherited as descriptors 3, 4, …). No tool is ever handed a name inside the tree: acl 2.3.2 `setfacl -P` follows a name a share user swaps for a symbolic link between the listing and the write (node proof 2026-11-15: 216 of 1500 runs), so for each entry the helper does `lstat` → `sysopen O_PATH|O_NOFOLLOW` relative to the directory it holds → `fstat` and compares device, inode and type with the `lstat` (a mismatch is `swapped`: never touched) → runs `chown`, `setfacl` and `chmod` on `/proc/self/fd/N`, in batches. Symbolic links, FIFOs, sockets and device nodes are never opened. A boundary is a different mount (`mnt_id` from `/proc/self/fdinfo`) or a different device: a root of its own that the plan names is counted (`nestedRoots`) and walked as its own root; any other is never entered and is reported with its identity. Each directory is read twice and entries are met once per inode (a bind mount of a sibling folder shows that folder's inode: its mount tells it apart, it is named as a boundary and the folder is walked, whichever the folder lists first — cr3.nodefix D3); the reads of one directory are bounded, so a user renaming without end cannot hold the walk. Regular files with more than one hard link are walked like any other entry. The roots are the target's directory and each child dataset the confirm names that `findmnt` shows mounted at its mountpoint (on ZFS the PVE-descendant refusal guards them and is asked first); every other mount under the path is pruned from every walk and named in the confirm (`not changed: <path> (<fstype>)`) and in the job result (`notChanged`). On btrfs a subvolume has its own `st_dev` and no mount line: the plan lists the nested subvolumes under an AHR pool's `@data` (`btrfs subvolume list`; an empty or unparseable list refuses) and names each as a root, so a subvolume a user created after the plan is a boundary. A ZFS root skips its `.zfs`. **What the job says** (`walkVerdict`): the helper answers one bounded JSON report whose counts must add up (`accounted`). Exit 0 with nothing left over completes; a completed walk that left anything out completes as `INCOMPLETE: the walk finished, but …; apply again to retry the rest.`, naming up to five entries per cause: an entry swapped under the walk, a per-entry tool error, a directory too deep for the descriptor budget (1,024 levels at most) or not entered, a directory that changed or kept changing while it was read, an entry that disappeared while the walk read it (the walk cannot tell a move from a delete, and an entry moved into a directory the walk had finished is not met again), a boundary the plan did not name, a planned excluded mount the walk never met, or counts that do not add up. A refusal before the first change (exit 2) fails with `No permissions were changed: …`, or says which datasets already had POSIX ACLs switched on; a walk that stopped part-way (exit 3, a signal, no readable report) fails and says how far it got; a cancel stops the helper's process group and is reported as a cancel only when one was asked for. A file moved into an already-walked directory before the walk reached its old directory is not seen at all: a live tree being rearranged during the walk can end with entries unchanged, and applying again covers them. The plan reads that scope (the child datasets and `findmnt --json`) and its revision binds it, so a mount or child that appears after the confirm is `STATE_CHANGED`; an unreadable list or mount table refuses the change (409). The walks keep no deadline (cr.34: hours on a large tree); the one hang that has nothing to do with the tree's size — the lstat of a dead NFS/CIFS mountpoint the walk passes — is refused first: each such mount gets the mounts family's `timeout 2 stat -f` probe and a dead one fails the job before anything is touched. A recursive grant with named entries lists the descendants (`zfs list -r -H -o name,mountpoint,acltype <dataset>`), keeps those mounted under the path (`legacy`, `none` and mounts elsewhere are not reached), and switches POSIX ACLs on (`zfs set acltype=posixacl xattr=sa`, the target's own first-grant rule) for each that has them off, BEFORE any permission changes — a child with `acltype=off` would otherwise fail `setfacl` part-way, after the parent was set; a failed enable stops the job before anything is touched and names the child; the job result lists the children enabled (`childAclEnabled`, also on the share grant's result). On AHR the walk sweeps every subvolume under `@data` as one tree and never `@snapshots`, a sibling outside the mount; **PVE territory** — a ZFS target asks the footprint service, a non-ZFS directory asks storage.cfg's `path`/`mountpoint` keys (refused when the directory sits at or under one; a recursive apply refused when one sits inside the tree; an unreadable storage.cfg refuses); **iSCSI** — no refusal (operator ruling 2026-10-11): a permission change leaves a LUN image's contents alone, the ZFS editor never gated a dataset holding one, and a hard 409 left an AHR pool holding a LUN with no writable share; the pool rows keep `heldByLun`, and the recursive apply's confirm names a LUN image under the path. **The confirm** (operator ruling 2026-10-11) — `applyToExisting` is a Level 2 dangerous operation on every door that can carry it (`PUT …/access` on a dataset, an AHR pool, an SMB share or an NFS export, and the SMB create/edit `grantAccess.applyToExisting`): asked after every refusal, `409` + `X-Anas-Confirm-Code`, operation `fs.setAccess.recursive` bound to the target, headline "Applying to existing files rewrites the permissions of every file and directory under '<path>'", warnings naming what the walk reaches on that target (the child datasets crossed and those whose ACLs are switched on first, the other filesystems below it that are not changed, the subvolume sweep, a LUN image) and that the previous permissions are not recorded. The UI carries the headline verbatim (`confirmAndRun` with `confirmHeadline`). **The recursive write sequence** (live proof 0.4.3 F1, F2, F3): after the refusals, the confirm and the child-dataset switch, a grant with named entries walks `chown -h` when the owner or group changes, then `setfacl -b -m <spec>` with `X` for every execute bit, the mask included (`u::rwX,g::r-X,o::r-X,u:<name>:rwX,m::rwX`): setfacl resolves `X` against the ACL it builds, so one literal `x` would make every plain file executable, and `-b -m` (not `--set`) resolves it against each file's own bits, so a file that was executable stays so and a plain file never becomes so; then `setfacl -d --set` with the lowercase spec on directories only; then setgid (`chmod g+s`) on directories only, never on files; the helper applies every step to a batch of entries before it moves on. A mountpoint-only apply keeps the lowercase `--set` spec and `chmod g+s` on the one directory. Clearing named entries recursively keeps the `g-s` walk over files as well, which repairs trees marked by the earlier writer. **SMB inheritance** (operator ruling 2026-10-11, re-proof RF1) — ANAS-written share stanzas carry `inherit acls = yes`, `create mask = 0664` and `directory mask = 0775`: all three on create; an edit that runs a grant adds each one the stanza does not set under any spelling (`create mode` and `directory mode` are Samba's synonyms of the masks), and an operator's value stands; an edit with no grant leaves the stanza byte-identical. Samba creates a file with mode 0666 (plus owner execute from the DOS archive bit) AND `create mask`, a directory with 0777 AND `directory mask`, and the kernel clamps the inherited default ACL's mask entry with that mode's group bits. With Samba's defaults (0744, 0755) every named user ends at read on what another user saved, `inherit acls` or not (Samba 4.22.11, re-proof §5). With 0664 a new file's mask is `rw-`: the named users read-write, the group and everyone read, no execute bit; with 0775 a new directory's mask is `rwx`. Cross-checked against two NAS products: OpenMediaVault's share template writes `inherit acls` (on by default), `create mask = 0664`, `directory mask = 0775` and the matching `force create mode`/`force directory mode`; TrueNAS SCALE's middleware writes `create mask = 0664` and `directory mask = 0775` globally (user-settable) and, on POSIX ACL datasets, no inherit flag. ANAS writes no `force … mode` (a client's read-only attribute is honoured; TrueNAS writes none either) and no `inherit permissions` (neither product does). Known residual, the same on both products: on a share with guest access where named users also sign in, Everyone stays at read on the files those users save, so a guest can open them and not change them; when every session is a guest, all files belong to the one guest account and stay writable. **Refusal before confirm on every door** — the editor's `PUT …/access` asks its gates and plans before the 409; the SMB create/edit door prepares the whole grant (gates, composition, plan) before the 409, asks no confirm when the grant would be refused or would do nothing, saves the share, and reports the refusal in `grant`; a share job that finds a recursive apply its request never confirmed refuses it. The GET payload gains an optional `backing: zfs | ahr | other` on the AHR and share routes (the datasets payload is unchanged; absent reads as `zfs`).

### SMB Operations
| Operation | Command |
|-----------|---------|
| `smb.config.get` | Read smb.conf through the round-trip parser in `parsers/smb-conf.ts` (no `net` call — the `net conf` registry was considered and rejected, see Config File Management) |
| `smb.config.set` | Write smb.conf section |
| `smb.share.add` | Add share to smb.conf |
| `smb.share.remove` | Remove share from smb.conf |
| `smb.service.restart` | `systemctl restart smbd` |
| `smb.status` | `smbstatus` |

**Self-service on SMB shares (smbsvc.1–3, designed 2026-09-22, trimmed after the operator's review — GitHub #62 + shelved Time Machine / Previous Versions).** Three per-share features, each a checkbox in the SMB share dialog, each pure surgical `smb.conf` wiring of Samba VFS modules the node already ships (`shadow_copy2.so`, `recycle.so`, `fruit.so`, `catia.so`, `streams_xattr.so` — Samba 4.22.11 on PVE 9). One composer emits the `vfs objects` line from the set of enabled features; the feature keys become managed parameters in `parsers/smb-conf.ts` next to the existing ones, so an untouched edit still rewrites byte-identically (§2 dialog↔daemon contract). **Ground truth 2026-09-22 (stunt node, Samba 4.22.11, ZFS dataset with `anas-daily-…`, `anas-hourly-…`, a manual and a `pre_GMT…` snapshot, `smbclient` as the client):** the full stack `vfs objects = catia fruit streams_xattr shadow_copy2 recycle` works — Previous Versions enumerates exactly the scheduled snapshot, a file reads back through the `@GMT-…` path, deletes land in the bin; **`shadow:snapprefix` is broken on 4.22** (every shape, including the man page's own `pre` + `_GMT` example, answers `NT_STATUS_INVALID_NETWORK_RESPONSE` on enumeration and `NT_STATUS_NO_MEMORY` on the path) — so a share exposes ONE snapshot bucket through a fixed `shadow:format`. `vfs_recycle` with `keeptree` + `versions` keeps the tree and `Copy #n of` duplicates, the bin is visible to the client at the share root, and a recycled file's **ctime is the deletion time** (the rename sets it; users cannot forge it), which is what the purge keys on. **Design rule applied throughout (operator, 2026-09-22): the simplest mechanism that gives the user the outcome — no pickers for things ANAS can decide, no lifecycles for things that can simply stay, no second store beside `smb.conf`.**

- **Previous Versions (`smbsvc.1`).** `vfs_shadow_copy2`. ANAS itself picks the finest snapshot schedule bucket on the share's dataset (hourly before daily before weekly…) and writes `shadow:format = anas-<bucket>-%Y-%m-%dT%H%M%SZ`, `shadow:localtime = no`, `shadow:sort = desc`; the dialog and detail show which bucket, read-only. Manual snapshots, replication bases and `anas-backup-*` transients never appear. No schedule on the dataset is NOT a refusal: the feature enables with `daily` as the format and the dialog says Previous Versions stays empty until a schedule on this dataset runs, naming the Snapshots menu. *ZFS:* `shadow:snapdir = .zfs/snapshot` (relative) + `shadow:snapdirseverywhere = yes`, so a share rooted below the dataset root resolves at the dataset's own `.zfs`; child datasets are separate mounts and the walk stops there. *AHR (visible divergence):* snapshots live in the `@snapshots` subvolume, mounted only transiently today — enabling the feature on a pool adds ONE read-only fstab mount `subvol=@snapshots,ro,nofail` at `/mnt/anas-ahr-snapshots/<pool>` (a sibling of the pool's mount base, never inside the data tree) and `shadow:snapdir` is that absolute path; **the mount stays** (harmless, read-only) — no enable/disable counting. A flat-layout AHR pool (`subvolLayout: false`) or a share on a path that is neither a ZFS dataset nor an AHR pool cannot enable it — the dialog greys the row with the reason, the daemon refuses 400.
- **Recycle bin (`smbsvc.2`, GitHub #62).** `vfs_recycle` with `recycle:repository = #recycle` (the name users know; visible at the share root — a hidden dot-directory would defeat self-service), `recycle:keeptree = yes`, `recycle:versions = yes`, `recycle:touch = yes`; the bin lives on the share's own filesystem (no cross-filesystem copies, counts against the same quota). **Purge policy** = age since deletion, per share: 7 / 14 / 30 / 90 days or never, default 30, stored IN the share's stanza as an ANAS marker comment `# anas:recycle-purge-days = 30` (the fstab `#ANAS` marker pattern — the config file stays the one store; the parser preserves it verbatim and ANAS rewrites only that line). Mechanism per §2 "never build a scheduler": ONE static daily timer `anas-recycle.timer` + runner installed by the package (`install.sh`, removed by `uninstall.sh`) — nothing is created or removed per share; the runner scans `smb.conf` for stanzas carrying both `recycle:repository` and the marker, runs `find <path>/#recycle -type f -ctime +<days> -delete`, prunes empty directories, logs per-share counts to journald, and does nothing for shares without a marker or with `never`. Turning the feature OFF leaves the existing `#recycle` directory in place (a checkbox never deletes data) and the dialog says so. **Users empty their own bin (GT 2026-09-22):** deleting a file inside `#recycle` is a real delete (the module recognises its repository — no loop, no nested bin), deleting the `#recycle` folder empties the bin, and Samba recreates it on the next delete; the dialog states this in one sentence. No admin "empty now" verb, no bin size cap (the module has none — only a per-file bypass, which is another knob to explain), no per-user bins.
- **Time Machine target (`smbsvc.3`) — BETA.** `vfs objects` gains `catia fruit streams_xattr` (this order; Samba requires `streams_xattr` with `fruit`), `fruit:time machine = yes` (Samba then forces `durable handles`, `kernel oplocks = no`, `kernel share modes = no`, `posix locking = no` for the share — ANAS writes nothing extra) and the **required** `fruit:time machine max size = <cap>`: Time Machine expands to fill what it sees, and per the man page the cap counts only sparsebundle contents, so the dialog states that the share must be dedicated to Time Machine. Quota = the fruit cap on BOTH stacks (uniform; on AHR it is the only mechanism), suggested value = half the dataset's available space; one line says a ZFS quota on the dataset is the hard limit and is set in Datasets. **No avahi**: the dialog states the destination is selected by mounting the share in Finder or with `tmutil setdestination`. **Beta status is explicit** (dialog row label "Time Machine target (beta)", detail, release notes): the server side is configured exactly per the Samba documentation and proven with `testparm`, but no current macOS is on the test bench — the client side is community-verified, and the release notes ask for reports.
- **`vfs objects` ownership.** Order when stacked: `catia fruit streams_xattr shadow_copy2 recycle` (ground-truthed). ANAS owns the line while any feature is on. A share that already carries a user-verbatim `vfs objects` line cannot enable a feature: the dialog greys the rows with "this share has a custom `vfs objects` line — remove it first" and the daemon refuses 400 (no merging). When the last feature is turned off the line is removed. The feature keys (`shadow:*`, `recycle:*`, `fruit:time machine*`) are managed; anything else stays verbatim passthrough.
- **Workflow (equal weight).** *Where it lives:* the Shares menu, SMB share dialog, a "Self-service" fieldset with three rows; the detail window shows the effective settings (bucket, purge age, cap). No grid column. *Happy path:* Edit share → tick Previous Versions → the row shows "exposes the daily schedule's snapshots" (or the empty-until-a-schedule-runs note) → OK → job → grid reloads, detail shows the format written. Recycle: tick + purge age combo. Time Machine (beta): tick + cap prefilled with the suggestion + the dedicated-share and Finder/`tmutil` sentences. *Timeliness:* the grid reloads after every job, success and failure; the bucket is read live when the dialog opens. *Failure as the user meets it:* rows greyed with the reason (flat AHR pool, non-snapshot path, custom `vfs objects` line); daemon refusals (400) name the share and the reason; `testparm` runs after every write and a failing config is rolled back byte-identically with the daemon's sentence in the toast (the existing reload-as-side-effect path). *Proof:* live on the stunt node with `smbclient`: enumeration lists exactly the bucket's snapshots, `get @GMT-…/file` reads the old content, `del` lands in `#recycle` with the tree kept, the purge runner deletes only files older than the age, `testparm -s` shows the Time Machine keys as written (Samba's enforced settings are connect-time module behaviour and do not appear in the config dump — GT 2026-09-23); the AHR variant on a loop AHR pool with the `@snapshots` mount; Playwright over the dialog (rows, greyed reasons, cap prefill, reload after an injected failure).

### NFS Operations
| Operation | Command |
|-----------|---------|
| `nfs.exports.get` | Read /etc/exports |
| `nfs.exports.set` | Write /etc/exports |
| `nfs.export.add` | Add export entry |
| `nfs.export.remove` | Remove export entry |
| `nfs.reload` | `exportfs -ra` |

### System Operations
| Operation | Command |
|-----------|---------|
| `system.disks` | `lsblk -Jb` |
| `system.disk.smart` | `smartctl -a <device>` |

### Identity — share users & groups (Epic 8)

Users/groups are read **only** via `getent`/nsswitch (source-agnostic — local, LDAP, AD all surface the same; NEVER parse `/etc/passwd`). ANAS creates only **share** identities: no login shell, no Unix password, and no user-private group (`useradd -N -M -s /usr/sbin/nologin`) — they exist to own files (uid/gid → NFS) and optionally hold an SMB password (Samba passdb). They cannot log into the box or PVE. Directory-provided users are read-only here (provisioned in AD/LDAP — Epic 14). All mutations are jobs.

| Operation | Command |
|-----------|---------|
| `identity.users` | `getent passwd` (pickers + list; filtered to real accounts) |
| `identity.groups` | `getent group` |
| `identity.user.local` | `getent -s files passwd <name>` (manageable vs directory) |
| `identity.smb.list` | `pdbedit -L` (which users have an SMB passdb entry — `smbEnabled` only for an exact-case entry mapped to the account's uid, `smbEntryMismatch` names a stale one) |
| `identity.user.add` | `useradd -N -M -s /usr/sbin/nologin [-c <gecos>] [-G <groups>] <name>` (`-N`: no user-private group) |
| `identity.user.disable` | `usermod --lock --expiredate 1 <name>` + `smbpasswd -d <name>` |
| `identity.user.enable` | `usermod --unlock --expiredate '' <name>` + `smbpasswd -e <name>` |
| `identity.user.delete` | `pdbedit -x -u <stored name>` FIRST (only if a passdb entry Samba would use for the account exists — found case-folded, dropped by the name it is stored under, so an orphan or case-mismatched entry never blocks the delete; identity.3), then `userdel <name>` (no `-r` — its files keep their uid) |
| `identity.group.add` | `groupadd <name>` |
| `identity.group.members` | `gpasswd -a` / `gpasswd -d <user> <group>` |
| `identity.group.delete` | `groupdel <name>` |
| `identity.smbpasswd.set` | `smbpasswd -a -s <name>` (password on stdin, never argv), then `pdbedit -L` must show `<name>` EXACTLY with `getent`'s uid; a mismatched entry is replaced (`pdbedit -x -u <stored>` + `smbpasswd -a -s` again, re-verified) — identity.3 |
| `identity.smbpasswd.clear` | `smbpasswd -x <name>` |

> **Permissions editor (Epic 4.7 → 4.7.1):** the layered access UI is backed by **POSIX ACLs** (`getfacl`/`setfacl`, `acltype=posixacl`) — owner/group/mode for the base rows, named-user/group ACL entries for extra principals, and a default ACL + setgid for inheritance. NFSv4 ACLs are **deferred to Epic 14** (they earn their complexity only for Windows-file-server parity, which pairs with an AD join). No `passwd`/`chpasswd` — ANAS never sets a Unix login password.

### iSCSI Operations (LIO — iscsi epic)

- `targetcli <one command>` — create/delete/set for backstores, targets, TPGs, portals, LUNs, ACLs; `saveconfig`; always ONE command per invocation (real exit code), serialized behind a daemon mutex
- direct configfs writes under `/sys/kernel/config/target/` for CHAP secrets only (argv-free; round-trips through `saveconfig`)
- reads: `/etc/rtslib-fb-target/saveconfig.json`, configfs (`acls/<iqn>/info` for sessions, `CLAIMED`/`udev_path` for the busy diagnosis)
- `systemctl restart rtslib-fb-targetctl` never issued by ANAS (a restore over a degraded state persists the hole); enable/disable via `targetcli`

**AHR-backed LUN images stay copy-on-write (ruled 2026-09-11).** `createSparseImage` is open+truncate and stays so — no `chattr +C`, no `nodatacow`, no per-LUN toggle. The btrfs data checksum is the whole reason an AHR image is a better block object than a raw LV: it keeps the image inside scrub attribution and self-heal, and snapshots (every backup run, every schedule) defeat NOCOW anyway (first write after a snapshot is CoW-once, so the file fragments regardless while losing its checksums). Guidance is placement, not a flag — the add-LUN dialog's AHR branch says so: random-write block workloads belong on a zvol; an image on spinning AHR expects fragmentation, and a later defragment unshares snapshot extents.

### Backup restore operations (proxmox-backup-client — backup2 epic)

- nested-filesystem detection (backup2.2): `timeout <s> find -P <path> -xdev -maxdepth N -type d -printf '%D\t%p\n'` (our own machine format — no structured tool walks `st_dev`), `findmnt --json`, `btrfs subvolume show <path>`; the backup call gains `--include-dev <path>` per included boundary — **`includeNested: all` is resolved at run time into per-archive `--include-dev` paths; `--all-file-systems` is never emitted** (it is per-invocation and would spill onto sibling archives)
- `proxmox-backup-client snapshot list --output-format json`, `list`
- `proxmox-backup-client catalog shell <snap> <archive>` driven over a pipe (`ls`, `stat`, `find`) — the archive browser; never `mount` (FUSE)
- `proxmox-backup-client restore <snap> <archive> <target|-> [--pattern …] [--allow-existing-dirs --overwrite] [--ignore-*] [--rate]`
- `proxmox-backup-client map` / `unmap` (`unmap` with no argument = sweep of stale loop devices)
- `zfs set snapdev=visible` / `zfs inherit snapdev` around a zvol snapshot backup (`set snapdev=hidden` would leave `source=local`)

### Cloud sync operations (rclone — rclone.1–3)

Every call carries `--config /etc/anas/rclone.conf --ask-password=false` (ANAS's own file — root's default config is never touched; anasd has no `HOME` anyway; a password-protected file fails at the first read and is reported, never prompted for).

- `rclone version`, `rclone config providers` (the dialog's schema), `rclone config dump` (the read side AND the post-write gate)
- `rclone obscure -` (password on stdin — never argv); the section itself is written by ANAS's surgical INI edit, not by `rclone config create/update/delete`, because 1.60's `rc` accepts input only as an argv string
- `timeout <s> rclone lsjson <remote>:<path> --max-depth 1 --contimeout 10s --timeout 30s --retries 1 --low-level-retries 1` — the Test probe; an unsaved remote is defined through `RCLONE_CONFIG_ANASTEST_*` environment variables
- `rclone copy|sync <source> <remote>:<path> --use-json-log -v --stats 5s --stats-log-level NOTICE [--bwlimit <rate>] [--exclude <pattern>]…` — the run; never `--max-delete`, never `--dry-run` in v1 (the preview shares the argv and ignores the per-file events)
- `systemctl` / `systemd-analyze calendar` for the `anas-cloud-<name>` units, `journalctl -u` for recent runs — as backup

### AHR, replication transport, mounts & helper binaries (added by the cr.71 docs-vs-code pass)

The tables above were written before the AHR, mounts, replication and schedule epics shipped; these are the other
binaries anasd runs — same rule throughout: mapped operations, `execFile` with array args, no shell. Each row names
the family that runs it.

| Binary | Why (family) |
|--------|---------|
| `mdadm` | AHR: create/grow/rebuild/re-add/spare management, detail/examine reads (md's event hook is an ANAS script wired into `mdadm.conf`'s `PROGRAM` line — not a daemon call) |
| `sgdisk`, `partx` | AHR: GPT band-slice tables by the by-id convention; partition-table re-read after slice changes |
| `pvcreate`, `vgcreate`, `vgextend`, `vgreduce`, `vgremove`, `vgchange`, `pvremove`, `pvresize`, `lvcreate`, `lvremove`, `lvextend`, `lvconvert` | AHR: the LVM layer between md and btrfs — create/destroy, cache attach/detach (`lvconvert --type cache` / `--uncache`), expansion |
| `pvs`, `vgs`, `lvs` | AHR: LVM inventory reads (machine-readable report) — band layout, cache state, expand previews |
| `dmsetup` | AHR: device-mapper mapping and cache-status truth (a cache block is gated on `dmsetup status`) |
| `mkfs.btrfs`, `btrfs` | AHR: filesystem over the pool LV; mount, subvolume create/show/list, usage reads |
| `ssh`, `ssh-keygen`, `ssh-keyscan` | replication transport: the remote `zfs recv` (the send always runs locally), remote `zfs hold`/`release`/`holds` and remote `zpool`/`zfs` reads — a cluster peer as `root@<node>` over PVE's own cluster ssh trust, a registered remote as its configured user (default `root`) with the ANAS key and the host key pinned in `/etc/pve/priv/anas/known_hosts`; `ssh-keygen` creates the ANAS ed25519 keypair, `ssh-keyscan` captures host keys for pinning |
| `mount`, `umount` | mounts: the kernel actions behind the verb ladder; the AHR `@snapshots` read-only mount; a failed-remount recovery |
| `findmnt` | mounts/backup: the live mount table behind every inventory and nested-boundary read (`--json`) |
| `systemd-escape` | mounts: a mountpoint escaped into its `.mount`/`.automount` unit name (the ZFS import-instance name is escaped in-process — no shell-out there) |
| `systemd-analyze` | schedules/replication/cloud: `calendar` — validate a schedule before writing a unit |
| `journalctl` | schedules/scrub/AHR: recent runs of ANAS-owned units (the last-scrub verdict, run viewers) |
| `node` | the `ExecStart` interpreter of the runner units the schedule/backup/replication/cloud verbs write |
| `timeout` | probes: every hang-prone guard — dead NFS/CIFS `stat -f`, write tests, remote probes (the budget ladder in `executor/command-budgets.ts`) |
| `stat` | probes: capacity/type/ino reads behind `timeout` — a mountpoint is never touched unguarded |
| `find` | The backup2.2 nested-filesystem detect, bounded (`-xdev`, `-prune`) |
| `perl` | The recursive permission walk (`anas-acl-walk.pl`, core modules only); perl is PVE's own runtime |
| `sort` | probes: dedup in a composed pipeline (identity scans via `executor.pipeline`) |
| `cat` | AHR/scrub: read `/proc/mdstat` (md state) |
| `touch`, `rm` | probes: guarded write-capability test on a restore/backup target |
| `dd`, `sync` | AHR self-heal: `O_DIRECT` read sweeps and the one arbitrated repair write (`conv=fsync`), and the cache-drop sequence a cold read needs |
| `blkid` | pools/AHR/cache: filesystem/RAID signature reads (wipe guards, slice identity, composable-disk facts) |
| `mkdir` | mounts/shares: the mountpoint directory of a created mount or the `@snapshots` helper mount |
| `mv` | AHR: rollback's instant subvolume swap — `@data` is preserved as `@snapshots/pre-rollback-<ts>`, nothing destroyed |
| `testparm` | SMB: the post-write config gate — a failing result rolls the stanza back byte-identically |
| `ip` | iSCSI: `ip -j addr` — the portal addresses offered to initiators |
| `udevadm` | AHR: settle after disk/slice changes before re-reading by-id paths |
| `lsof`, `fuser` | mounts/busy diagnosis: which processes hold a mount (the 409 that names them) |
| `prlimit` | backup restore: the fd ceiling around one `proxmox-backup-client` run (it execs the client in place, so the cancel hook signals the real pid) |
| `pve-firewall` | iSCSI: the firewall advisory read |
| `perl` | notifications: one `perl -e 'use PVE::Notify; …'` call per event (the PVE stack, not ours) |
| `update-initramfs` | AHR expansion: refresh the boot image after the disk layout changes |
| `wipefs` | (listed above under `disk.wipe`) also AHR detach: clear a released slice so the disk reads `available` |

No whitelist name above lacks a caller; conversely, binaries that appear in old drafts but no longer run were
dropped — there is no `base64` call (base64 is a Node `Buffer` transform, never a child process), and the daemon
never runs `net`, `systemd-escape` for ZFS import names, or `sanoid`.

### Parameter validation

Every operation has a schema defining valid parameters. anasd validates before execution:

- Pool names: alphanumeric + underscore/hyphen, no path separators
- Device paths: must start with `/dev/`, must exist as block device
- Dataset names: valid ZFS path characters only
- Property values: validated against known ZFS property types
- Share names: alphanumeric + underscore/hyphen
- Paths: must be absolute, no traversal (`..`)

---
