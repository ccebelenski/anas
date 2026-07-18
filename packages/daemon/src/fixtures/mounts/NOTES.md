# Mounts — ground-truth capture (story 18.1)

Captured on the stunt PVE 9 node `192.168.200.50` (`anas-pve`), 2026-07-18.
Environment: `pve-manager/9.2.4`, kernel `7.0.14-4-pve`, `util-linux 2.41`
(`findmnt`/`lsblk`), `nfs-utils 2.8.3`, `samba 4.22.10`, `cifs-utils 7.4`,
`lsof 4.99.4`, `psmisc 23.7` (`fuser`).

These are the **exact bytes** each command produced (or a file's exact
content). They exist to drive the stage-2 parser/schema work for Epic 18
(Mounts). No parser exists yet — this is reality first.

> **Test topology.** Everything is loopback on one node: an `nfs-kernel-server`
> export (`/srv/nfs/export1`) and a Samba share (`//anastest` → `/srv/smb/share1`,
> user `smbtest`) are mounted back onto the same host as client mounts under
> `/mnt/anas-*`. A throwaway 200 MB file-backed zpool `mnttest` provides a local
> ZFS mount for the combined inventory. PVE `dir` + `nfs` storages were added via
> `pvesm` to capture the hands-off `/mnt/pve/*` shape, then removed.
> **Caveat:** loopback exaggerates two boot-ordering effects (see SURPRISES) —
> flagged where it matters.

---

## Fixture index

| File | What it is |
|------|------------|
| `findmnt-full.json` | `findmnt --json` — full mount tree, everything mounted (ext4, vfat, fuse, zfs×2, nfs4×3, cifs, autofs×2, all the kernel pseudo-fs) |
| `findmnt-real.json` | `findmnt --json --real` — only "real" filesystems (drops pseudo-fs; keeps the interesting mounts) |
| `findmnt-root.json` | `findmnt --json /` — a single local ext4 mount |
| `findmnt-nfs.json` | `findmnt --json /mnt/anas-nfs` — one nfs4 client mount, effective options |
| `findmnt-cifs.json` | `findmnt --json /mnt/anas-cifs` — one cifs client mount, effective options |
| `findmnt-zfs.json` | `findmnt --json /mnttest` — one zfs mount |
| `findmnt-pve-nfs.json` | `findmnt --json /mnt/pve/anastest-nfs` — the PVE-owned NFS mount |
| `findmnt-automount-armed.json` | `findmnt --json /mnt/anas-auto` BEFORE first access — the `autofs` placeholder |
| `findmnt-automount-mounted.json` | same AFTER `ls` — autofs placeholder **stacked with** the real nfs4 mount |
| `lsblk-O-full.json` | `lsblk -J -O` — every column (unwieldy; kept for reference) |
| `lsblk-trimmed.json` | `lsblk -J -o NAME,TYPE,FSTYPE,SIZE,FSSIZE,FSUSED,FSAVAIL,MOUNTPOINTS,LABEL,UUID,RM,RO,HOTPLUG,TRAN,MODEL,SERIAL` — the fields the inventory & 18.6 removable-detection actually want |
| `fstab-stock` | the node's original 2-line `/etc/fstab` (installer output) |
| `fstab-anas-managed` | `/etc/fstab` after ANAS-style entries were appended (nfs, cifs, automount) |
| `fstab-handedited-sample` | a **constructed messy** fstab: tabs vs spaces, whole-line + inline comments, a commented-out entry, unknown/exotic options, bind + tmpfs. The round-trip parser's torture test |
| `fstab-boot-test.txt` | `/etc/fstab` as it was during the reboot spot-check (adds an unreachable-server `nofail` entry) |
| `storage.cfg` | `/etc/pve/storage.cfg` with a `dir:` and an `nfs:` storage added — the READ-ONLY hands-off parse source |
| `pvesm-status.txt` | `pvesm status` stdout (PVE storage states) |
| `generator-nfs.mount` | the unit systemd-fstab-generator wrote for the NFS entry (`/run/systemd/generator/`) |
| `generator-cifs.mount` | same for the CIFS entry |
| `generator-auto.automount` / `generator-auto.mount` | the `.automount`+`.mount` pair generated for the `x-systemd.automount` entry |
| `systemctl-show-nfs.txt` / `systemctl-show-cifs.txt` | `systemctl show <unit>` trimmed to the load-bearing properties |
| `mountstats-nfs.txt` | `/proc/self/mountstats` excerpt for the NFS mount (per-op stats, caps, xprt) |
| `creds-anastest.cred` | the exact credentials-file format `mount.cifs` accepted (throwaway test secret) |
| `stat-f-exit-codes.txt` | **the status design center** — `timeout 2 stat -f` across healthy / unmounted / missing / stale / dead-server / recovered |
| `busy-unmount.txt` | `umount` on a busy mount + `fuser -vm` + `lsof +f` (the 409 holding-process list) |
| `mount-nfs-failures.txt` | `mount.nfs` stderr + exit for unreachable / refused / not-found / protocol variants |
| `mount-cifs-failures.txt` | `mount.cifs` stderr + exit + dmesg for unreachable / refused / auth / not-found / protocol |
| `boot-behavior.txt` | post-reboot: `systemctl --failed`, unit states, mounts recovered |
| `boot-cifs-failure-journal.txt` | journal + dmesg showing WHY the CIFS mount failed at boot |

---

## 1. Inventory shapes (findmnt / lsblk)

**`findmnt --json` gives everything the inventory needs and is safe** — it reads
the kernel mount table (`/proc/self/mountinfo`), so it **never touches a
mountpoint's filesystem** and never hangs, even on a dead NFS server (proven in
§4). Per-filesystem object shape:

```json
{ "target": "...", "source": "...", "fstype": "...", "options": "..." }
```

- `--json` (full) includes ~40 pseudo-filesystems (proc/sys/cgroup/tmpfs/...).
  The inventory must **filter by fstype** or use `--real`.
- `--json --real` drops most pseudo-fs but **keeps `autofs`** placeholders and
  `fuse` (`/etc/pve`, lxcfs). Not a clean "real disks" filter on its own.
- `findmnt --json <mountpoint>` returns a one-element `filesystems` array with the
  **effective (kernel) options** — richer than fstab (e.g. NFS shows negotiated
  `vers=4.2,rsize=524288,...`; CIFS shows `vers=3.1.1,cache=strict,...`).
- fstype values seen: `ext4`, `vfat`, `zfs`, `nfs4`, `cifs`, `autofs`, `fuse`,
  `fuse.lxcfs`, plus kernel pseudo-fs. **NFS is `nfs4` not `nfs`** when v4 is
  negotiated. **CIFS `stat -f` Type is `smb2`** even for a 3.1.1 mount.
- `source` disambiguates kind: `127.0.0.1:/srv/...` (NFS), `//host/share` (CIFS),
  poolname (`mnttest`, ZFS), `/dev/...` or `UUID=`/`PARTUUID=` (local),
  `systemd-1` (**autofs placeholder** — the tell for an armed-but-unmounted automount).

**`lsblk -J -O`** is huge (every column). `lsblk-trimmed.json` is the useful set.
For 18.6 removable detection the fields are **`rm`** (removable bit) and
**`hotplug`** and **`tran`** (transport: `sata`/`usb`/`nvme`/...). On this VM the
CD-ROM `sr0` shows `rm:true, tran:"sata"`; no USB present. `fssize/fsused/fsavail`
give capacity without mounting for **local** filesystems, but are `null` for
remote/unmounted — capacity for remote still needs the guarded `stat -f`.

---

## 2. fstab variants → round-trip parser requirements

`fstab-stock` is trivial (2 installer lines). `fstab-handedited-sample` is the
real test. The parser (18.2) MUST preserve, verbatim:

- **Whole-line comments** and **blank lines**, in position.
- **Inline trailing comments** (`... 0 0   # media library` — everything after
  `#` on a data line).
- **Mixed whitespace**: some rows tab-separated (`^I`), some space-aligned. Do
  **not** normalize.
- **Commented-out entries** (`#UUID=A1B2-C3D4 /mnt/usb ...`) — a disabled mount
  the operator is keeping; must round-trip as an opaque comment, not be revived.
- **Unknown/exotic options** carried verbatim in a passthrough field:
  `x-gvfs-show`, `x-anas-note=keep-this-unknown-option`, `comment=cloudconfig`,
  `_netdev`. The DESIGN's "structured known tier + verbatim passthrough" is
  mandatory — these must survive an edit to an *unrelated* field on the same line.
- **Non-mount entry types**: `bind` mounts (`type none ... bind`) and `tmpfs`.
  ANAS doesn't manage these but must not corrupt them.
- 6-field layout is not guaranteed regular — dump/pass are sometimes tab-, sometimes
  space-separated; the last two fields may have odd spacing.

Identity is the **mountpoint** (field 2), matching the DESIGN (URL-encoded
mountpoint key).

---

## 3. PVE artifact mounts (hands-off tagging)

`storage.cfg` gained (via `pvesm add`):

```
dir: anastest-dir
	path /srv/pve-dir
	content iso,backup
nfs: anastest-nfs
	export /srv/nfs/export1
	path /mnt/pve/anastest-nfs
	server 127.0.0.1
	content backup
	options vers=4.2
```

- A PVE `nfs:` storage lands its mount at **`path /mnt/pve/<id>`** (here
  `/mnt/pve/anastest-nfs`) and appears in `findmnt` as an ordinary `nfs4` mount —
  **indistinguishable from an ANAS mount by findmnt alone.** The ONLY way to tag
  it hands-off is to cross-reference the `storage.cfg` parse (the proven 3.25
  read-only pattern). Match on the mount `target` starting `/mnt/pve/` **and/or**
  the storage's `path`/`mountpoint`. PVE `dir:` storages carry a `path` too
  (`/srv/pve-dir`, `/var/lib/vz`) but are not their own mount — they ride an
  existing fs.
- `pvesm status` (`pvesm-status.txt`) columns: `Name Type Status Total Used
  Available %`. The phantom `datapool` (a `zfspool` storage for a pool that
  doesn't exist on this node) shows `inactive` and, on **stderr**, spews
  `zfs error: cannot open 'datapool'` three times per call. **The daemon must
  read `storage.cfg` directly, not shell `pvesm status`** — the latter is noisy,
  slow, and errors on unrelated storages. `storage.cfg` is the API (Principle 13).
- PVE writes `options vers=4.2` into `storage.cfg` but the kernel mount shows the
  same negotiated options as any nfs4 mount.

---

## 4. THE STATUS DESIGN CENTER — `timeout 2 stat -f` exit-code table

Full verbatim runs in `stat-f-exit-codes.txt`. The design's hang-trap rule is
**confirmed and load-bearing**: a dead NFS server hangs `stat` forever; `timeout`
is what makes liveness probing safe.

| Scenario | `timeout 2 stat -f` exit | stderr | how to tell it apart |
|----------|:---:|--------|----------------------|
| Healthy local (ext4/zfs/vfat) | **0** | — | prints `Type:` + block counts |
| Healthy remote (nfs4) | **0** | — | `Type: nfs`, real block counts |
| Healthy remote (cifs) | **0** | — | `Type: smb2`, `Inodes: Total 0` |
| **Dead NFS server** (hard mount, server down) | **124** | — (killed) | **timeout fired** — elapsed ≈ 2000 ms. THE hang case |
| **ESTALE** (server-side inode removed under an open handle) | **1** | `Stale file handle` | exit 1 **with** "Stale file handle" |
| Nonexistent path | **1** | `No such file or directory` | exit 1 **with** "No such file..." |
| **Unmounted mountpoint** (empty dir, nothing mounted) | **0** | — | **exit 0 but reports the UNDERLYING fs** — same `ID:` as `/` |

**Verdict mapping for `GET /v1/mounts` health (`ok/stale/unreachable/unmounted`):**

- `exit 124` → **unreachable** (server dead / network gone; the classic hang).
- `exit 1` + stderr contains `Stale file handle` → **stale** (ESTALE).
- `exit 0` → mounted and answering → **ok** — BUT see the trap below.
- `exit 1` + `No such file` → the path doesn't exist (config/idempotency issue).

> **TRAP — `stat -f` alone cannot detect "unmounted".** On an empty mountpoint
> with nothing mounted, `stat -f` succeeds (exit 0) and silently returns the
> **parent/underlying** filesystem's stats (identical `ID:` to `/`). So "exit 0"
> does NOT prove the intended fs is mounted. **`unmounted` must be decided by
> `findmnt` (is `target` in the mount table?), not by `stat -f`.** The design's
> flow should be: findmnt says configured-but-not-in-table → `unmounted`;
> in-table → then `stat -f` classifies `ok`/`stale`/`unreachable`. Capacity
> numbers from `stat -f` are only trustworthy once findmnt confirms the mount.

Other confirmed facts:
- **`findmnt` never hangs on the dead mount** — it listed `/mnt/anas-nfs` fine
  (exit 0) while `stat -f` on it timed out. Safe to call unconditionally.
- **Healthy mounts stay instant while a sibling is dead** — with `nfs-server`
  stopped, `stat -f /` and `stat -f /mnt/anas-cifs` returned in <1 ms, exit 0.
  Probing is per-mount; one dead server doesn't poison the others.
- **Recovery is automatic** — after `systemctl start nfs-server`, `stat -f` on the
  previously-hung `hard` mount returned exit 0 with real data. No remount needed.
- ESTALE required a **held handle to a removed sub-inode**. Swapping the *export
  root* inode did NOT produce ESTALE — NFSv4 transparently re-resolved the
  mountpoint to the new dir (plain `stat` showed a new inode + new content). So
  "stale" is a per-object condition, not usually a whole-mount one; a mount-root
  `stat -f` may read `ok` even when sub-paths are stale.

---

## 5. Busy unmount → the 409 holding-process list

`busy-unmount.txt`. Two holders: a process with an **open FD** on a file in the
mount, and a process with **CWD** inside it.

- `umount /mnt/anas-cifs` → **exit 32**, stderr `umount: /mnt/anas-cifs: target is
  busy.` (same for `umount <device>`). Exit **32** is the umount busy signal.
- `fuser -vm <mp>` → exit 0; table on **stderr** with an `ACCESS` column:
  `f` = open file, `c` = cwd, plus a `kernel mount` row for the mountpoint itself.
- `fuser -m <mp>` → terse PIDs on stdout (`5960  5961c` — trailing letter = access
  type).
- `lsof +f -- <mp>` → exit 0; clean columnar stdout, one row per open ref with
  `FD` (`0r`, `cwd`), `TYPE` (`REG`/`DIR`), and `NAME`. `lsof -t +f -- <mp>` →
  bare PIDs.
- **Recommendation:** `lsof +f -- <mp>` gives the richest structured data for the
  409 `holding processes` list (PID + command + what they hold). `fuser` is the
  psmisc fallback (always present; `lsof` needed a package install here). After
  releasing holders, `umount` returned exit 0 immediately — no lazy/force needed.

---

## 6. `mount.nfs` / `mount.cifs` failure taxonomy → `POST /v1/mounts/test`

**Every failure exits 32.** The **stderr string** (mount.nfs) or the
**`mount error(N)` errno** (mount.cifs) is the discriminator, not the exit code.
Use `-o soft,timeo=10,retrans=1,retry=0` (+ wrap in `timeout`) so probes fail fast
instead of retrying for ~2 minutes.

### NFS (`mount-nfs-failures.txt`)

| DESIGN verdict | trigger | `mount.nfs4` stderr (verbatim) |
|----------------|---------|--------------------------------|
| **unreachable** | bogus IP / no route | `mount.nfs4: Connection timed out for <spec> on <mp>` |
| **unreachable** | reachable host, closed port | `mount.nfs4: Connection refused for <spec> on <mp>` |
| **unreachable** | reachable host, wrong service (port 445) | `mount.nfs4: Connection timed out ...` |
| **not-found** | server OK, export path missing | `mount.nfs4: mounting <spec> failed, reason given by server: No such file or directory` |
| **protocol-mismatch** | server has v4 disabled, client asks vers=4.2 | `mount.nfs4: Protocol not supported for <spec> on <mp>` |
| **protocol-mismatch** | unsupported version (nfsvers=2) | `mount.nfs: requested NFS version or transport protocol is not supported for <mp>` |

Notes: v3 and v4.0 **succeeded** against this server (it offers 3/4/4.1/4.2) — a
version request only fails if the server truly lacks it. "Connection refused" vs
"Connection timed out" both fold into **unreachable** (refused = host up port
closed; timed out = no route/no answer) — the test can report the nuance but the
verdict is the same.

### CIFS (`mount-cifs-failures.txt`)

`mount.cifs` puts the **errno in `mount error(N)`**; the SMB-level status is in
`dmesg` (kernel log). Both captured.

| DESIGN verdict | trigger | `mount error(N)` (verbatim) | dmesg / notes |
|----------------|---------|-----------------------------|---------------|
| **unreachable** | bogus IP | `mount error(115): could not connect to <ip>Unable to find suitable address.` | `-115 EHOSTUNREACH` |
| **unreachable** | reachable host, closed port | `mount error(111): could not connect to <ip>Unable to find suitable address.` | `-111 ECONNREFUSED` |
| **auth-failed** | wrong password | `mount error(13): Permission denied` | dmesg `STATUS_LOGON_FAILURE` |
| **auth-failed** | unknown username | `mount error(13): Permission denied` | **same as bad password — CIFS cannot distinguish the two** |
| **not-found** | bad share name | `mount error(2): No such file or directory` | dmesg `BAD_NETWORK_NAME` |
| **protocol-mismatch** | vers=1.0, server has SMB1 off | `mount error(95): Operation not supported` | `-95 EOPNOTSUPP` |

Notes: vers=2.0 **succeeded** (server negotiates SMB2). The errno taxonomy is
stable and enough for the verdict; `dmesg` gives the authoritative SMB status
(`STATUS_LOGON_FAILURE` / `BAD_NETWORK_NAME`) but requires root + is racy/global —
**prefer parsing the `mount error(N)` number over scraping dmesg.** The trailing
`Refer to the mount.cifs(8) manual page...` line is boilerplate; strip it.

---

## 7. Credentials-file format (`creds-anastest.cred`)

The exact content `mount.cifs` accepted, mode **0600 root:root**:

```
username=smbtest
password=Passw0rd123
domain=WORKGROUP
```

- Three `key=value` lines, no quoting, no spaces around `=`. `domain=` is optional
  (mount worked without it in the failure probes via inline `username=`/`password=`).
- Referenced from fstab as `credentials=/etc/anas/creds/<name>.cred`. The DESIGN's
  per-mount `/etc/anas/creds/*.cred` 0600 root-only files match this format exactly.
- (Throwaway test secret on a disposable node — safe to keep verbatim as a fixture.)

---

## 8. systemd unit-naming & generator facts

- **Unit name = `systemd-escape -p --suffix=mount <mountpoint>`.**
  `/mnt/anas-nfs` → `mnt-anas\x2dnfs.mount`. The **hyphen becomes `\x2d`**
  (hyphen is systemd's path separator); leading `/` dropped; slashes → `-`.
  **CRITICAL for the daemon:** in `execFile` args pass the literal
  `mnt-anas\x2dnfs.mount` (one backslash); in a shell you must double it. Always
  derive the unit name via `systemd-escape`, never hand-build it.
- **Generator writes to `/run/systemd/generator/<unit>`** (tmpfs, regenerated on
  every `daemon-reload`/boot). `FragmentPath` points there; `SourcePath=/etc/fstab`.
  Generated `.mount` body (`generator-nfs.mount`): `[Mount] What=/Where=/Type=/
  Options=` copied straight from the fstab line (fstab options **as written**, not
  the negotiated ones).
- **A new fstab line is not live until `systemctl daemon-reload`** (re-runs the
  generator). `mount <mountpoint>` then works because the entry resolves.
- **`systemctl show <unit>` load-bearing props** (`systemctl-show-nfs.txt`):
  `Where`, `What`, `Type`, `Options` (negotiated/effective), `ActiveState`
  (`active`), `SubState` (`mounted`), `LoadState` (`loaded`), `Result`,
  `FragmentPath`, `SourcePath`, `WantedBy=remote-fs.target`.
- **Ordering differs by type — this is the boot story (see SURPRISES):**
  - NFS unit `After=` includes **`nfs-server.service`** + `network-online.target`
    + `remote-fs-pre.target`.
  - CIFS unit `After=` includes `network-online.target` + `remote-fs-pre.target`
    but **NO `smbd`/server ordering**.
- Persisted remote mounts are `WantedBy=remote-fs.target` (not `local-fs.target`).

### Automount armed-vs-mounted signatures (`x-systemd.automount`)

The DESIGN needs status to distinguish **armed** (autofs placeholder, nothing
mounted yet) from **mounted** (real fs present). Signatures:

| | armed (before access) | mounted (after access) |
|--|----------------------|------------------------|
| `findmnt --json <mp>` | **one** obj: `source:"systemd-1"`, `fstype:"autofs"` | **two** objs stacked on same target: the `autofs` placeholder **and** the real `nfs4`/`cifs` mount |
| `.automount` unit | `ActiveState=active` `SubState=waiting` | `active` `running` |
| `.mount` unit | `ActiveState=inactive` `SubState=dead` | `active` `mounted` |

- `x-systemd.automount` makes the generator emit **both** a `.automount` and a
  `.mount` (`generator-auto.automount` + `generator-auto.mount`); the `.automount`
  is `WantedBy` the fs target, the `.mount` is triggered on access.
- `x-systemd.idle-timeout=60` → autofs `timeout=60` (unmounts after 60 s idle,
  then re-arms). Round-trips to the autofs mount's `options`.
- **`daemon-reload` alone does NOT arm** the automount — the `.automount` unit is
  `loaded`/`inactive` until something **starts** it (boot's fs target, or manual
  `systemctl start`). After a reboot it re-armed on its own (`active/waiting`).
- **Key upshot:** for an automount, `findmnt` showing only `autofs`/`systemd-1`
  means **armed, not broken** — the health model must read this as a distinct
  state, never as `unreachable`. Only the presence of the second (real) stacked
  entry means "currently mounted".

---

## 9. Boot behavior spot-check (`boot-behavior.txt`, `boot-cifs-failure-journal.txt`)

Rebooted the VM once with an **unreachable-server `nofail` NFS entry**
(`192.0.2.9`, `soft,timeo=30,retrans=2,retry=0,_netdev,x-systemd.mount-timeout=20`)
plus the existing nfs/cifs/automount entries.

- **Boot completed.** `multi-user.target` reached (`active`); SSH + both ANAS
  services (`anasd`, `anas`) came back on their own. External
  `curl -k https://192.168.200.50:3000/api/health` returned JSON
  (`{"error":{"code":"UNAUTHORIZED",...}}` = gateway up, PVE auth required). So
  **`nofail` did its core job: an absent server did not block boot.**
- Healthy mounts recovered automatically: `/mnt/anas-nfs`, `/mnt/pve/anastest-nfs`
  (nfs4), `/mnttest` (zfs), and the automount **re-armed** (`autofs`, waiting).

### SURPRISES — flag loudly for stage-2 design

**SURPRISE A — `nofail` does NOT prevent a *failed unit*; it only prevents
boot-blocking.** After boot, `systemctl --failed` listed
`mnt-anas\x2dunreach.mount` (`Result=exit-code`, `ActiveState=failed`) and the
system state was **`degraded`, not `running`**. `nofail` removes the mount from
the fs-target *requirement* (so boot proceeds) but the mount unit still runs,
fails, and is reported failed. **Design impact:** the daemon must NOT treat a
systemd unit in `failed` state as "broken mount" for a `nofail` entry — for an
absent server that is the *expected, healthy-by-policy* outcome. Authoritative
health = `findmnt` (mounted?) + guarded `stat -f`; systemd `failed` for a nofail
mount just means "not currently mounted". Also: **ANAS's own `nofail` mounts will
make `systemctl is-system-running` report `degraded`** — if any ANAS status/health
surface keys off that global state, absent remote servers will look alarming when
they're fine. (An unrelated pre-existing `zfs-import@datapool.service` was also
failed — more evidence global system-state is a noisy signal.)

**SURPRISE B — the CIFS mount FAILED at boot** (`mount error(111)` /
`cifs_mount failed w/return code = -111`, ECONNREFUSED). Cause
(`boot-cifs-failure-journal.txt`): the mount fired at **t≈4.5 s, before `smbd` was
listening** on 127.0.0.1:445. The NFS loopback mount survived the same boot because
its generated unit carries **`After=nfs-server.service`** — systemd's nfs
integration orders the client mount after the local server. **CIFS gets no
equivalent `smbd` ordering**, so a loopback/local CIFS mount races smbd and loses.
Design impact:
  - For **loopback / same-node** CIFS this is intrinsic — needs an explicit
    `After=smbd.service` drop-in or (better) `x-systemd.automount` so the mount
    only fires on first access (post-boot). *This is partly a loopback artifact;
    a truly remote already-up SMB server is reached via `network-online.target`
    ordering, which both units have.*
  - **Default remote CIFS entries should carry `_netdev`** (orders after
    `network-online.target`) and the daemon should seriously consider making
    `x-systemd.automount` the recommended default for CIFS — it sidesteps the
    entire boot-ordering + server-not-ready class, and matches the DESIGN's
    "automount an exposed toggle for flaky links".
  - Both the CIFS and the unreachable-NFS mounts came back cleanly with a manual
    `mount` once their servers were reachable, and `systemctl reset-failed`
    cleared the degraded state. Nothing was permanently wedged.

---

## Summary of design-relevant takeaways

1. **`findmnt --json` is the safe backbone** of the inventory — never hangs, gives
   effective options, disambiguates kind via `source`/`fstype`. Filter pseudo-fs.
2. **`stat -f` under `timeout` classifies liveness** — exit **124** = unreachable
   (the hang), exit **1 + "Stale file handle"** = stale, exit **0** = answering.
   **But `unmounted` must come from `findmnt`, not `stat -f`** (exit 0 on an empty
   mountpoint silently reports the underlying fs).
3. **Failure verdicts** come from the mount helper's **message/errno** (all exit
   32): NFS via stderr string, CIFS via `mount error(N)`. Bad-password and
   bad-username are indistinguishable on CIFS (both `error(13)`).
4. **`nofail` keeps boot safe but leaves failed units + a `degraded` system** —
   don't treat unit-`failed` as broken for nofail mounts.
5. **CIFS is boot-order-fragile** (no server ordering); prefer `_netdev` and lean
   toward `x-systemd.automount` for remote CIFS.
6. **PVE mounts are only distinguishable via the `storage.cfg` read-only parse**
   (`/mnt/pve/*` + storage `path`); read the file, don't shell `pvesm status`.
7. **Unit names via `systemd-escape -p --suffix=mount`** — hyphens become `\x2d`;
   never hand-build. Generator output lives in `/run/systemd/generator/` and needs
   `daemon-reload` after any fstab edit.
