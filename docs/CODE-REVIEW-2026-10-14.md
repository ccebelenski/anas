# Whole-project code review — 2026-10-14

**Status:** read-only review at main `026bf64` (0.4.3 + test commits), operator-ordered. Nothing
here is fixed by this document; it is the evidence for the stories cut from it. Scope: the whole
repository — daemon, gateway, shared schemas, PVE integration (ExtJS + Perl hook + installers),
packaging, CI, governing docs. Focus: inconsistencies, identity problems, workflow issues, bad
practice. Paths are relative to `packages/daemon/src` unless they start with another top-level
directory or `shared/` (= `packages/shared/src/`).

**Evidence levels.** **[V]** = re-read in the code by the reviewer after the finding was raised
(file:line confirmed). **[R]** = reported with file:line by a scoped review pass, not
independently re-verified; treat as a strong lead and confirm before fixing. **(uncertain)** =
the reporting pass itself flagged doubt.

**Amplifier (design, not a bug).** Auth is binary (PRINCIPLES §10): any principal holding a valid
PVE ticket — including a `@pve` realm user with no PVE privileges at all — has full ANAS. Every
injection below is therefore reachable by any PVE account, not only by administrators. Worth an
operator ruling: the gateway could require one PVE privilege (e.g. `Sys.Modify` on `/`) without
introducing a role matrix.

---

## 1. Critical — authenticated user to root / host compromise

**C1. SSH option injection in replication remotes → root command execution. [V]**
`services/replication-transport.ts:83-100` (`buildSshArgv`) places `` `${resolved.user}@${resolved.host}` ``
directly after the option list, with no `--`. `POST /replication/remotes/test`
(`routes/replication-remotes.ts:361-371`) validates `user` only as a non-empty string (no Zod
schema on this route); the stored-remote schema allows anything without control characters
(`shared/schemas/replication.ts:237-240`). `user = "-oProxyCommand=<cmd>"` with `?pin=true`
against any reachable sshd (localhost works): the pin succeeds, then `sshExec(resolved, ['true'])`
hands ssh `-oProxyCommand=<cmd>@host` as an option and ssh runs `<cmd>` via `/bin/sh` as root.
**Fix:** strict regexes for `user` (POSIX name) and `host` (hostname/IP, no leading `-`); parse the
test route's body with the shared schema; `--` before the destination in `buildSshArgv`; audit
`ssh-keyscan` argv for the same.

**C2. `/etc/fstab` line and field injection. [V]**
`extraOptions` is a bare `z.string()` (`shared/schemas/mounts.ts:536, 561`), stored verbatim
(`services/mounts.ts:676`, `routes/mounts.ts:1036`) and emitted raw by `buildOptionTokens`
(`parsers/fstab.ts:739-740`) into `serializeMountLine` (`:253-255`). A newline forges a complete
extra fstab line. Separately, spaces/tabs/`#` in `mountpoint` (allowed by `AbsolutePath`) or in
`remotePath` are never `\040`-escaped, so e.g. mountpoint `/usr nfs4 rw 0 0 #` shifts the fields,
bypasses the PVE/ZFS mountpoint guards (`routes/mounts.ts:239-259`) and drops the forced `nofail`.
(The 2026-10-06 identity audit listed missing `\040` escaping as cosmetic; it is an injection.)
**Fix:** `extraOptions` = strict comma-separated option tokens (refuse `credentials=`, `password=`,
`username=`); octal-escape space, tab, `\` and `#` on write and unescape on read.

**C3. System accounts are mutable through the identity API. [V for root disable; R for the rest]**
`parsers/getent.ts:37-38` deliberately treats uid 0 as share-relevant. `PUT /identity/users/root
{enabled:false}` runs `usermod --expiredate 1 root` (`routes/share-identity.ts:644-653`); the only
gate is "is it a local user". PAM account checks (PVE `@pam` login, sshd) honour expiry, so this
very likely locks out root@pam (uncertain: not proven live). User delete has no uid floor
(`:783-866`); group membership edits and group delete accept `sudo`/`root`/`disk`
(`:713-774, 873-943`); SMB password can be set for root (`:548`). `CreateShareUserRequest.groups`
is `z.string()[]` (`shared/schemas/identity.ts:135`) passed to `useradd -G`
(`routes/share-identity.ts:477-478`), so a new share user can be placed in `sudo`, `disk`, `shadow`
or `root`; `fullName` is unvalidated.
**Fix:** refuse uid/gid 0, < 1000 and 65534 on every identity mutation, at the route and re-checked
in the job; `groups` = `IdentityName[]` restricted to gid ≥ 1000; validate `fullName` as
`SingleLine` without `:`.

---

## 2. High

**H1. No CSRF protection on any `/anas` mutation. [V]**
The pveproxy hook is spliced after the `/api2` dispatch block
(`packages/pve-integration/install.sh:116-139`), so PVE's ticket + `CSRFPreventionToken` check never
runs for `/anas/*`. `perl/AnasProxy.pm:166-222` forwards everything; the gateway authenticates on
the cookie alone (`packages/gateway/src/server.ts:68-91`); the UI does not send the token
(`packages/pve-integration/src/10-api.js:48-59`). `SameSite=Lax` blocks cross-site, not same-site
origins (another port on the same host/IP, sibling subdomains). The daemon keeps Fastify's default
`text/plain` parser, so a plain HTML form can drive body-less POSTs (`/pools/:name/scrub`, `/trim`,
`/backup/tasks/:name/run`, `/schedules/:id/run`, `/replication/tasks/:name/run`, `/ahr/:name/scrub`).
Confirm-gated ops are protected only because the attacker cannot read the 409's header.
**Fix:** UI sends `CSRFPreventionToken`; gateway verifies it on every non-GET exactly as PVE does
(HMAC over `<ts>:<user>` with the cluster's `pve-www.key`); daemon refuses non-JSON bodies.

**H2. Uninstall can roll PVE's HTTP server module back to a stale copy. [V]**
`capture_pristine_backup` (`packages/pve-integration/install.sh:145-156`) writes
`AnyEvent.pm.anas-orig` once and never refreshes it. After a `libpve-http-server-perl` upgrade the
apt hook re-splices the NEW module but the backup is still the OLD one; `uninstall.sh:116-118`
prefers the backup over marker excision, and the `perl -c` gate passes (old code compiles). Result:
PVE's own module silently downgraded.
**Fix:** always excise by marker and delete the whole-file backup path, or refresh the backup
whenever the live file lacks the marker.

**H3. More config-file injection. [R]**
(a) smb.conf: a value ending in `\` is a line continuation (`parsers/smb-conf.ts:101-103`);
`SingleLine` permits `\` and values are written raw (`:1076-1098`, `replaceValue` `:800-811`). A
final `valid users` entry `bob\` swallows the next line (e.g. `hosts allow`); `testparm` accepts it.
(b) `/etc/exports`: `NfsClient.spec`/`options` accept any `SingleLine`
(`shared/schemas/shares.ts:207-218`) — spaces, `(`, `)`, `,` add clients; a `"` in a path breaks the
quoting (`parsers/exports.ts:127-133`) and sidesteps the PVE path check; the parser ignores `\`
continuations and inline `#` (`:145-186`); a failed `exportfs -ra` leaves the bad file
(`routes/shares-nfs.ts:112-119`).
(c) rclone.conf: option values are `z.record(z.string(), z.string())` with no control-char check
(`shared/schemas/cloud.ts:121, 137, 149`), written `${k} = ${v}` (`parsers/rclone-conf.ts:235`); the
post-write check compares non-secret values only (`services/rclone-config.ts:756-766`), so a newline
in a secret non-password key can forge sections; `normalizeOAuthToken` passes multi-line pastes
through (`:171-172`).
**Fix:** one per-format "value is safe for this file" layer in `shared/` used by every writer:
reject trailing `\` (smb.conf), strict spec/option regexes and no `"`/`\`/`#` in paths (exports),
no control chars anywhere and `JSON.stringify` tokens (rclone); roll back `/etc/exports` when the
reload fails.

**H4. ZFS argument injection and unconfirmed force flags. [R]**
`ImportPoolRequest.name`/`.guid` are bare `z.string()` (`shared/schemas/zfs.ts:462-475`) into
`zpool import` argv (`routes/pools.ts:1395-1401`): `name = "-aDf"` imports every destroyed pool with
force; `force` (-f, can corrupt a pool active on another host) has no confirm. Pool create: `force`
→ `zpool create -f` with no confirm (`pools.ts:420-421`); disk ids unvalidated (`../../sdb` resolves
out of by-id, `:393-395`); ids unknown to the inventory pass (`:642-645`); inventory read failure
admits everything (`:633-640`). `VdevSpec.disks`, `cacheDisks`, `spareDisks`,
`AddVdevRequest.disks`, `AttachDiskRequest.newDiskId` are bare strings
(`shared/schemas/zfs.ts:351, 390-392, 491, 594-596`). `GET /pools/:name/datasets/*` passes an
unvalidated pool name to `zfs get -j all` (`routes/datasets.ts:809, 840-842`; read-only).
**Fix:** `PoolName`, `/^\d+$/` guid, `DiskId` everywhere a disk is named; `--` before operands;
refuse unknown disks; fail closed on inventory errors; confirm-gate `force` on import and create.

**H5. Legacy permissions route: unconfirmed recursion and chown option injection. [R]**
`PUT …/permissions` with `recursive:true` runs `chown -R`/`chmod -R` with no confirm
(`routes/datasets.ts:1269-1290`) — contrary to the access.1 ruling that every recursive apply is
confirm-gated (the `setAccess` path does gate, `:1369`). `owner`/`group` are bare strings
(`shared/schemas/datasets.ts:295-298`): `owner = "--reference=/x"` becomes a chown option
(`datasets.ts:1274-1277`). The PVE-descendant refusal is request-time only. (uncertain: whether the
UI still calls this route — if not, remove it.)

**H6. AHR LVM teardown is keyed by VG name only; create's rollback reuses it. [V]**
`services/ahr-destroy.ts:317-339` lists LVs where `vgName === name` and `lvremove -y`s every one,
then `vgremove -y name`, with no check that the VG's PVs are this pool's arrays. A failed create
calls `destroyAhrPool` as rollback (`services/ahr-create.ts:582-616`). The only guard against a
foreign VG of the same name (PVE's `pve`) is a request-time `vgs` check that fails open when `vgs`
errors (`routes/ahr-mutate.ts:460-465`); the job-time occupancy check covers md arrays, pins and
labels but not VG names (`services/ahr-identity.ts:331-351`). Latent, but the blast radius is VM
disks. Related [R]: `isOwnedArray` accepts any unpinned `<vg>-r<N>` array when `pinned.size === 0 &&
vgExists` (`services/ahr-identity.ts:139`, used by `services/ahr-topology.ts:545-550`), which can
promote an unrelated VG to an "AHR pool" and expose it to Destroy; `ahrNameOccupancy` fails open on
unreadable sources (`:328-350`).
**Fix:** capture the VG UUID right after `vgcreate` and gate every LVM teardown on it (or on every
PV being an owned array/cache slice); add VG names to the job-time occupancy check and fail closed.

**H7. Root writes predictable names inside user-writable trees, following symlinks. [R]**
`touch .anas-restore-write-test-<pid>` (`services/backup-restore-files.ts:541-547`) and the partial
marker `writeFile` (`:661-667`) in restore destinations a share user can write. A planted symlink
creates/truncates an arbitrary root-owned path (e.g. `/etc/nologin`).
**Fix:** random name, `O_CREAT|O_EXCL|O_NOFOLLOW`.

**H8. Request-time-only checks — the audit's P1 class is not fully closed. [R]**
- ZFS create / add-vdev / attach: disk eligibility only at request (`routes/pools.ts:1341-1353,
  1504, 1742`); attach/replace/raidz-expand skip `vdevTopologyGate` that add/remove call
  (`:1496, 1587` vs `:1711-1900`).
- Pool destroy/export and rollback: LUN-held and system-pool checks not re-run in the job
  (`pools.ts:1991-1993, 2106-2112`; `datasets.ts:1896-1898`) although dataset destroy does
  (`recheckDestroyGates`, `datasets.ts:562-579`). `zfs destroy -r` still sweeps children created
  after the challenge (only the parent guid is bound, `datasets.ts:1544`). Upgrade and mountpoint
  confirms are name-only (`pools.ts:1042, 1240`).
- AHR expand / replace / cache-attach: no job-time `requireComposableNow`
  (`services/ahr-expand-resume.ts:263-271` → `ahr-expand-exec.ts:1368`); cache attach has no
  confirm at all and `sgdisk -n` writes a GPT over any whole-disk signature
  (`routes/ahr-cache.ts:201-208`, `services/ahr-cache.ts:385-396`).
- AHR destroy refuses in-flight `ahr.*` jobs at request time only (`routes/ahr-mutate.ts:769-778`
  vs job `:836-848`); destroy/mountpoint/remount LUN-held checks request-time only (`:627, 721, 787`).
- iSCSI: `reverifyServedLun` never compares sessions (`services/iscsi-served.ts:260-291`); LUN
  delete / file resize session gates request-time only (`routes/iscsi-mutate.ts:957, 808`); target
  update/state/delete act on the request-time target (`:455, 506, 574`) — a queued update can drop
  ACLs/portals added since; target delete can drop a LUN added since; add-LUN index from the
  request-time target (`services/iscsi-mutate.ts:1222`, audit #34).
- Schedule fire uses the schedule read by the route, not re-read in the job
  (`routes/schedules.ts:456-475`; deferred by ident.1 to "the identity epic").
- No per-object mutex for ZFS jobs (AHR has `findActive`; ZFS has nothing) and none per AHR pool
  across verbs; the queue runs 4 jobs at once.
**Fix:** one `safety/` helper: re-read the object under a per-object lock in the job, re-run every
request-time gate, refuse on mismatch.

---

## 3. Medium

**M1. No execution timeouts anywhere on the hot path. [V]**
`ExecOptions` has no timeout (`executor/types.ts`); `ProdExecutor.execBuffered` never sets one
(`executor/prod.ts:134-172`); only ~8 call sites wrap `/usr/bin/timeout`. The gateway's socket proxy
has no timeout (`packages/gateway/src/proxy.ts:136-153`). A hung `zpool status` (suspended pool),
`smartctl` or `getfacl` on dead storage blocks the request forever (AnasProxy gives the browser a 502
at 30 s, the daemon process stays), and a hung job permanently occupies one of the 4 slots.
**Fix:** default timeout in the executor (opt-out for long jobs), timeout on the socket proxy.

**M2. Deviations from the project's own contracts. [R]**
- Blocked operations answer 400, not 409 (PRINCIPLES §14): PVE-owned refusals at `pools.ts:721-723`,
  `datasets.ts:1445-1447` and siblings.
- Mutations outside the job queue (PRINCIPLES §4): the remote test routes write `known_hosts` and the
  cluster registry inline (`replication-remotes.ts:258, 265, 330-347`, the registry write swallows
  errors `:344-347`) then submit an empty "audit job" (`:351-357`); `/replication/tasks/:name/run`
  returns `{started:true}` and drops the job reference (`replication-tasks.ts:333-344`).
- Marker comments in fstab (PRINCIPLES §12 forbids them): disabled mounts are written with a
  `#ANAS ` prefix (`parsers/fstab.ts:243, 271`).
- `raidz` expansion and add data vdev (irreversible) have no confirm, `zpool upgrade` does
  (`pools.ts:1799, 1533` vs `:1042`).

**M3. Confirm codes do not bind the flags that change the blast radius. [R]**
`recursive`, `force`, `cleanup` are excluded from the bound params by design (`pools.ts:2079-2082`,
`datasets.ts:1521-1524, 1809-1811`): a code from a non-recursive challenge authorises a recursive
destroy. The UI appends `?cleanup=true` only on the confirmed resend
(`packages/pve-integration/src/37-pool-destroy.js:54-56`), so the daemon's "disks will be wiped"
warning (emitted only when `cleanup` is on the first request, `pools.ts:2069-2070`) is never shown.
**Fix:** collect options before the first request; bind them; re-challenge on change.

**M4. Atomic config writes are not durable and do not preserve metadata. [R]**
`services/config-writer.ts` promises fsync in its header (`:7-13`) and never calls it (`:80-82`);
the temp file is forced to 0644 and the rename drops the original mode/owner/ACL; a crash-orphaned
temp keeps its old mode (mode applies only on create). The pattern is duplicated with drift in
`services/rclone-config.ts:541-548`, `services/backup-repos.ts:136, 170`,
`services/mounts.ts:853-856`, `services/replication-remotes.ts:168, 327`. rclone.conf writes have no
sha re-check (`rclone-config.ts:668-752`) and rclone itself rewrites the file on OAuth refresh — an
ANAS write can revert a fresh token (uncertain). `backup-repos.json` in `/etc/pve` is locked only
in-process (cross-node lost update, uncertain). The PVE integration installer writes
`index.html.tpl` and `AnyEvent.pm` with `cat tmp > target` (truncate in place;
`packages/pve-integration/install.sh:239, 365, 389`, `uninstall.sh:84, 117, 142`), no `trap` for
`mktemp` leftovers.
**Fix:** one helper — exclusive temp in the same dir, copy mode/uid/gid, fsync file + dir, sha
re-check, rename; installers: temp + `mv`.

**M5. UI rendering, job feedback and principle-14 drift. [R]**
- Raw HTML: `ANAS.errText`/`alertMsg` pass text through raw (`00-core.js:64, 356-362`) into
  `Ext.Msg.alert`/`Ext.toast`; job-failure alert (`10-api.js:251-253`), rejected alerts (`:212, 478`),
  cancel toast (`:246`) and ~30 `alertMsg(..., errText(err))` sites carry daemon stderr, which
  includes remote-controlled text (rclone, ssh). Columns without renderers: `39-ahr.js:3365`,
  `75-iscsi.js:2684`, `30-pools.js:1311`, `40-disks.js:549`; combo `tpl`s `72-cloud.js:954-955, 1681`;
  raw names in toasts `70-shares.js:1208, 1630`, `68-backup.js:4431`, `65-replication.js:2150`;
  `36-pool-export.js` intro unencoded (destroy encodes). The test-result panels encode correctly —
  inconsistent. **Fix:** encode by default in `alertMsg`/`toast`/`pollJob`, explicit `alertHtml`.
- `pollJob` (`10-api.js:268-271`) stops silently after one failed poll (neither callback fires;
  dialogs disabled in `onSubmitted` stay stuck), and reports a job still running after 15 s as
  complete (`:261-265`).
- Replication task delete calls `ANAS.api.del` directly (`65-replication.js:2174`): "deleted" toast
  on 202, failure never shown, 409 unhandled — a third job-handling pattern beside `runJob` and the
  hand-rolled poll in `69-snapshots.js:1453`.
- Poll loops re-select by the name captured at request start (`65-replication.js:368-401`,
  `68-backup.js:1732-1767`, `69-scrubs.js:660-703`) and have no load sequence — the user's newer
  selection is overwritten. The poll loop itself is copied 7× with no in-flight skip.
- Seven files use plain `runJob` (no `onConfirm`) and carry client-side "are you sure" prompts and
  button-disabling as the only guard (e.g. snapshot destroy `60-datasets.js:3191-3203`, iSCSI target
  delete `75-iscsi.js:1825-1852`) — safety deciding in the frontend, and a future daemon gate would
  dead-end in `jobRejected`. **Fix:** every mutation through `confirmAndRun`.

**M6. Identity and lifecycle items still open from the 2026-10-06 audit. [R, cross-checked]**
#22 export leaves `zfs-import@<pool>` enabled (`pools.ts:1988-2003`; destroy disables at `:2125`) —
the open `pools.r1` rider. #23 `global`/`homes`/`printers` share names accepted
(`shared/schemas/common.ts:106-110`, `parsers/smb-conf.ts:696-699`). #24 same-case orphan passdb
entry inherited (`share-identity.ts:498`). #25 user/group delete ignores ACLs, `+`/`&` groups,
`write list`, `admin users`, `force user/group` (`share-identity.ts:341-343`) — and with user delete
shipped, `useradd` hands the freed highest UID to the next user, who inherits every `u:<uid>` grant.
#28 parity-rewrite evidence keyed by pool name + band (`ahr-mutate.ts:1151-1154`). #29 AHR scrub list
unlocked RMW (`services/scrub-schedules.ts:314-344`). #30 AHR fstab line found by `mountpoint OR
spec`, the `@snapshots` line shares the spec (`services/share-selfservice.ts:237`, used at
`ahr-create.ts:264, 717`) — a second move deletes the snapshots line; the boot cache step mounts by
LV path (`ahr-boot-scan.ts:307-308`). #31 AHR rollback `mv @data` before checking the snapshot
exists, and `mv` without `-T` (`services/ahr-snapshots.ts:443-446`). #36 exports by first exact
match, `/etc/exports.d` unread (`parsers/exports.ts:68-75, 113-119`). #37 share paths on unmounted
storage read present (`routes/shares-smb.ts:34-45`). #38 replication base by name, not guid
(`routes/replication.ts:146-162`). #39 schedule/replication task delete during an active run
(`routes/schedules.ts:428-434`, `routes/replication-tasks.ts:298-305`). #43
(`services/ahr-create-status.ts:67, 135`). #44 mounts inventory joins by target only
(`services/mounts.ts:135-137`). #45 gateway drops the PVE realm (`alice@pve` = `alice@pam` in the
audit trail; uid from an unrelated local account, `packages/gateway/src/auth/providers/pve.ts`). #46
same-second `anas-<bucket>-<utc>` collision, no `RandomizedDelaySec`
(`services/snapshot-schedules.ts:115`). Retention: the `anas-` prefix is still not reserved on
manual create/rename (`shared/schemas/common.ts:99-103`), so a hand-made `anas-*` snapshot is pruned
as legacy-unstamped when one schedule covers the dataset. Cloud retarget detection (#15) guesses
destination keys by suffix (`services/cloud-retarget.ts:25-54`) — credential swaps (`access_key_id`)
are not a retarget and secrets are skipped (`:76`); no job-time re-check. Replication remote / PBS
repo PUT can change host or datastore without a retarget confirm (#33).

**M7. Shares, identity and mounts — further items. [R]**
- Jobs read passdb fail-open: delete uses `smbEntries()` (`share-identity.ts:845`) — a transient
  `pdbedit` failure skips the passdb removal but runs `userdel`, creating the #24 orphan; disable can
  skip `smbpasswd -d` (`:664`), leaving SMB live on a user shown locked. Use the strict reader in jobs.
- A non-persistent mount writes the mountpoint-hashed creds file — the same file an existing fstab
  entry uses — without the fstab check, which runs only when `persistent` (`routes/mounts.ts:262,
  290, 297-300`). Write creds only after the fstab edit succeeds; check fstab always.
- No denylist of system mount targets: `/`, `/etc`, `/usr`, `/boot`, `/var` accepted (non-empty dir
  is only a confirm) (`routes/mounts.ts:239-259`).
- AHR: pool names up to 255 chars pass validation but GPT labels hold 36 and md names 32 bytes —
  disks are wiped before partitioning/`mdadm --create` fails (`ahr-create.ts:366-372, 429`);
  spare removal zaps the disk without re-classifying it (`ahr-spare.ts:327-329`); replace retires the
  old disk by label regex with `oldWasHealthy` captured at job start (`ahr-expand-exec.ts:1360-1362,
  1448-1457`); a failed add-LUN leaves an orphan image/backstore (`routes/iscsi-mutate.ts:666-688`).
- `packaging/anas-cache-event.sh` builds the request from an attacker-plantable GPT label: `POOL`
  unencoded in the URL (`:96`), `LABEL` via `printf %s` into JSON (`:85`), sent with root identity.
  Validate both against the pool-name regex.

---

## 4. Low

- Confirm store grows unbounded within the 2-minute TTL (`safety/gate.ts:180`, `safety/confirm.ts:83-89`).
- Import job finds the new pool by diffing names before/after (`pools.ts:1413-1422`); read it by guid.
- `POST /schedules` existence check at request time, write in the job (`routes/schedules.ts:295-306`);
  `readSchedule` does not compare the embedded id with the filename (`services/snapshot-schedule-units.ts:210-217`).
- Backup `schedule` is bare `z.string()` into `OnCalendar=` (`shared/schemas/backup.ts:1121`); use `SingleLine`.
- `aclSupported` caches a failed probe until restart (`services/access.ts:348-351`).
- SMB share-path PVE check request-time only (`routes/shares-smb.ts:475, 561`).
- Recycle purge: realpath-then-unlink race; bin listed before `lstat` (`recycle-purge.ts:185-199`); use dirfd-relative ops.
- Swallowed errors: `connectionsByShare` (`routes/shares-smb.ts:192`) lets the delete confirm omit live sessions; `allUsers`/`allGroups` return `[]` on `getent` failure (`share-identity.ts:131-144`).
- `reverifyServedLun` treats two unreadable serials as equal (`services/iscsi-served.ts:275`); destroy `umount` without `--` (`ahr-destroy.ts:282, 296`); `dynamic_sessions` never counted (audit #26; foreign targets only).
- `packaging/anas-md-event.sh:170-232` notifies for every md array on the node, named `/dev/mdN`.
- `bin/selfheal-*.ts` ship in the release and bypass the queue and gates; `--assume-mismatch` skips the evidence gate; `poolFor` invents a `rig` pool on error. Exclude from the package or env-gate.
- Gateway: `readCookie`'s `decodeURIComponent` throws on a malformed cookie → 500 (`packages/gateway/src/server.ts:35`); a new `HttpsAgent` per forward (`proxy.ts:314`); no `X-Forwarded-For` from AnasProxy (every gateway log line is 127.0.0.1).
- Daemon start unlinks any existing socket unconditionally (`index.ts:25-27`) — a second manual instance steals the live daemon's socket. `anasd.service` could use `RuntimeDirectory=anas` instead of `ExecStartPre=mkdir`.
- Installer: `restart_pveproxy` uses `restart`, not reload-or-restart, even from the apt hook (`install.sh:81`); the apt hook regenerates `anas.js` and rewrites the template on every dpkg transaction; `ANAS_VERSION`/`SCRIPT_DIR` interpolated unescaped into generated JS / `node -p` (`:276, 290`); `${APT_REAPPLY}` unquoted in the apt string (`:434`). Root-controlled, low risk.
- `server.ts:151-548`: ~400 lines of dev-mock fixtures live inside the production `createServer`; the `mountsStoragePath` try/catch around `join` (`:433-439`) cannot throw and its comment ("only when the real PVE file is absent") does not describe the code. Move mock wiring to its own module.

---

## 5. Workflow, process and documentation

**W1. Governing documents contradict the code** (CLAUDE.md calls them non-negotiable).
- `docs/PRINCIPLES.md:17` ("session cookie → Nuxt"), `:29` ("Nuxt validates"), `:37` §8
  (`npm install -g anas`, `sudo anas setup`, "no external binaries") — EPICS §5 rejects that install
  path and `install.sh` apt-installs samba/rclone/mdadm/…; `CLAUDE.md:30` ("Nuxt and anasd").
- `docs/DESIGN.md:818, 879` (`npm install -g`, `anas doctor`), `:892-905` (`anas setup` creates an
  `anas` user — contradicts "both as root"), `:121` and `:1052` (YAML `/etc/anas/config.yaml`; none
  exists, EPICS §5 rejects it), `:20-27` "Out of scope (V1)" lists shipped features, `:991+` the Nuxt
  plan. `packages/pve-integration/src/20-notinstalled.js:7` comment says npm, code shows
  `./install.sh` (`:34`). `packaging/systemd/anas.service` comment says the gateway serves HTTPS from
  PVE's certs (story 13.8) — it is plain HTTP on loopback.
- **User delete:** `docs/EPICS.md:102` (§2 standing ruling "User delete is OUT") and `:232` (§5
  Rejected) vs identity.1 shipping `DELETE /v1/identity/users/:name` and `/groups/:name`
  (`routes/share-identity.ts:783`, DESIGN.md:398). Either the ruling or the code is wrong; M6 #25
  shows why it matters.
- **DESIGN API tables vs routes:** Users & Groups rows (`DESIGN.md:393-401`: `/v1/users/:uid`,
  `/v1/users/:uid/smbpassword`, `/v1/groups`) are all wrong — the code serves `/v1/identity/users/:name`,
  `/identity/users/:name/smb-password`, `/identity/groups`. Absent from DESIGN: replication
  (`/replication/tasks|remotes|peers|locations`), `/schedules*`, `/scrub*`, `/telemetry`,
  `pools/:p/attach|trim|upgrade|mountpoint|expansion`, the `/ahr*` family (partly in AHR-DESIGN).
  CLAUDE.md says "create no endpoints not in the design" — either regenerate the tables from the
  route registrations or amend the rule to "DESIGN or the epic's design doc".

**W2. Tracking documents are stale.**
- `docs/IDENTITY-AUDIT-2026-10-06.md` has no status: #1–#20 were closed by ident.1–4 in 0.4.2
  (941b6ad, 56f6505, b633ce4, baa6353, 0a32e87) with the residuals in H8/M6; #21–#47 are mostly open.
  Add a status column.
- `docs/EPICS.md` §4 still carries the "Identity epic … not authorized; groom into stories" candidate
  although its first four slices shipped. §3 "Active" says "Nothing shipped is described here" (`:153`)
  yet holds cloudproof.1/.2 (`:159-163`), dash.r1 (`:167`) and the entire released 0.4.3 slate
  (`:169-184`); the §1 table has no 0.4.3 row. §4 keeps three struck-through DONE/promoted entries
  (`:202, 204, 206`), a stray table row (`:214`), and duplicates of items already on the 0.4.4 slate;
  §2 (`:92`) says encryption is deferred until asked — it was asked (#69). Run the 0.4.3 retrospective
  move.
- `CONTRIBUTING.md:56` ("Unit tests (daemon + gateway)") understates the suite;
  `test/stunt-node/README.md` omits ~9 fixture scripts (ahrcache, ahrexpand, cloud-*, pvepool,
  smbsvc, topology-zoo, vdev, ident3-gt).

**W3. CI and release gates.**
- Never run by CI or `npm test`: `packaging/test/*.test.sh` (6 files),
  `packages/pve-integration/test/{apt-reapply,proxy-install,tpl-inject}.test.sh`,
  `packages/pve-integration/perl/t/AnasProxy.t`. EPICS cites several as proof (installer.1/.2).
  Add `test:unit:shell` and `test:unit:perl` (`prove`) to `test:unit`; install the perl deps in CI.
- `.github/workflows/release.yml` publishes from `make-release.sh` (build + boot smoke only) with no
  tests, no lint and no dependency on CI for the tagged commit — a red commit can be released.
- `tests/integration/**` (54 specs + helpers) and `playwright.config.ts` are never type-checked
  (package tsconfigs include only `src`; root tsconfig unused); `eslint.config.js:16` ignores
  `tests/integration/fixtures/**`, which are TS helpers, not captures.
- Release tarball ships ~240 compiled `__tests__/*.js` (package tsconfigs compile tests into `dist/`)
  and the `selfheal-*` binaries (see §4).
- Actions pinned to major tags, not SHAs; no `permissions:` block. `forbidOnly`/`retries` keyed on
  `CI` in `playwright.config.ts:7-8` are dead (integration never runs in CI — reasonable, but say so).

**W4. Repository hygiene.**
- `packages/daemon/src/fixtures/pve/anastest-tok.pw` is a real-format PBS API token secret
  (`18e2a7b5-…`), force-added past the `*.pw` ignore and referenced by nothing. If it was captured
  from the `test/pbs-node` VM, rotate it; replace it with an obviously fake UUID either way, and make
  the fixture exception explicit in `.gitignore` (`!packages/daemon/src/fixtures/**/*.pw`).
  `anastest-pw.pw` / `creds-anastest.cred` are test values (fine).
- `packages/web/` contains only `node_modules/.cache` but is still matched by the `packages/*`
  workspace glob — delete it. `.gitignore` (`.nuxt`, `.output`) and `eslint.config.js:4`
  (`vue: true`) are Nuxt/Vue leftovers.
- The test root password `anas-test` is repeated in `tests/integration/fixtures/auth.ts:5`,
  `cloud-api.ts:43`, `pve-ui.ts:31`; centralise it like the host in `fixtures/target.ts`.
- Commit subjects: last 60 average ~205 chars, 27 over 200, longest 643 (`a22d699`). They work as
  changelogs and break `--oneline`, `shortlog` and GitHub views. Subject ≤ 72, detail in the body.
- `docs/` mixes governing documents with process logs (`LIVE-PROOF-0.4.3-access-reproof.md` 4,242
  lines, `LIVE-PROOF-0.4.3-access.md` 2,445; nine `LIVE-PROOF-*`). Move them to `docs/proofs/`.
- `docs/EPICS.md` is 85 KB with nine lines over 2,000 characters; story text is carrying result
  narratives that belong in EPICS-HISTORY or the commit.

---

## 6. Verified sound (not re-litigated)

Gateway identity headers are built by the gateway, never copied from the client
(`packages/gateway/src/proxy.ts:112-120`); dev auth refuses to arm on a real PVE node without a
second override; cross-node forward verifies TLS against the cluster CA, fails closed, resolves peers
from `.members`, and has a loop guard; the daemon socket is chmod 0600 and `/run/anas` is 0755
(no connect window for non-root). `execFile` with argv arrays everywhere — no `shell: true`, no
`sh -c`. Secrets go on stdin or env, never argv (`smbpasswd -s`, PBS). Confirm codes are single-use
with expiry; jobs keyed by uuid; cancel is race-free. ident.1–4 fixes hold where checked (stamped
retention, guid-bound pool/dataset confirms, by-guid cleanup wipe, reserved dataset segments,
per-task hold tags, served-device rdev check for LUNs, UUID-gated AHR destroy and boot ladder, `(S)`
spare removal, hashed cred names, recycle symlink refusal, PBS group uniqueness). AnasProxy cannot
be used as an open proxy (fixed loopback host, redirects off). Version bump covers every location.

---

## 7. Suggested order of work

1. **C1, C2, C3, H1** — small, contained, highest exposure (any PVE login → root; CSRF).
2. **H2, H6** — the two ways ANAS can damage what it does not own (PVE's module, a foreign VG).
3. **H3, H4, H5, H7** — one shared per-format value validator in `shared/` used by every config
   writer, `--` on every argv carrying a user value, `DiskId`/`PoolName` on every name field,
   confirm-gate the `force` flags.
4. **H8 + M3** — one `safety/` helper: per-object lock, job-time re-read of the object and every
   request-time gate, flags bound into the confirm.
5. **M1** — executor default timeout and socket-proxy timeout.
6. **W1–W3** — bring PRINCIPLES/CLAUDE/DESIGN/EPICS back in line with the code (decide user delete),
   status column on the identity audit, wire shell + perl tests into CI, gate `release.yml` on tests
   and lint, exclude tests and selfheal bins from the tarball.
7. M2, M4–M7, §4 and W4 as grooming allows.
