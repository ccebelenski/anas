# ANAS — Epics & Stories

> **This is the live plan.** It holds what is being built, the rulings every
> change must respect, the serious candidates, and the things already rejected
> (so they are not re-derived). The full build history — every shipped story's
> design notes, live-proof accounts and incident write-ups — is frozen in
> **`docs/EPICS-HISTORY.md`**; read it only when you need the *rationale* behind a
> ruling. Rebuilt 2026-08-25 at the 0.2.12 → 0.3.0 boundary.

**Rules of this file**
- Only implement work that traces to a story here (CLAUDE.md). Not in a story ⇒ not in scope.
- Every story carries a status tag: `[open]`, `[in progress]`, `[done <date>]`, `[deferred]`, `[OBE]`.
- When an epic ships, its stories and notes move to `EPICS-HISTORY.md`; only its **standing rulings** stay here. Narrative never accumulates in this file.
- **Epics are named, not numbered.** A story's handle is `slug.N` (e.g. `iscsi.5`), shown beside its title; handles are stable, titles may be refined. Bare numeric refs like `3.25` or `Epic 16` are story numbers in `EPICS-HISTORY.md`.
- Story format: *As a [user|dev|component], I want …, so that …*. Numbering is identity, not order. Roles: **user** = any authenticated user (auth is binary); **dev** = prerequisite work with no user-facing deliverable; **component** = a UI/API consumer of another part.

---

## 1. Status at a glance (shipped)

| Epic | What | Landed | History (was) |
|---|---|---|---|
| **Foundation & test infra** | Gateway + daemon, shared Zod, jobs, executor, journald audit · stunt-node test infra + Playwright | V1 | Epic 0, 0.5 |
| **Auth** | PVE owns the session; `PVEAuthCookie` verified locally (RSA-SHA1) | V1 | Epic 1 |
| **Dashboard** | `GET /v1/status` aggregate, pool/share/disk/jobs/warnings, ZFS + AHR live telemetry | V1 · charts reworked 15.6 (0.2.10) | Epic 2 |
| **ZFS pools** | parsers, observe, act; Disk Health; composer (3.23), special/dedup vdevs, PVE-pool tagging (3.25), root dataset first-class (3.26), busy-diagnosis (3.29), waste gate (3.30), RAIDZ expansion (3.31) | V1 → 0.2.0 | Epic 3 |
| **Datasets** | tree, properties, POSIX-ACL permissions editor (4.7.2), compression/dedup/trim/sync toggles | V1 | Epic 4, 4.5 |
| **Snapshots** | list/create/rename/rollback/destroy/clone | V1 | Epic 5 |
| **Replication** | local + remote `zfs send/recv`, Replication menu, cluster remotes registry | V1 | Epic 5.5 |
| **Shares (SMB/NFS)** | round-trip parsers, surgical config editing, reload-as-side-effect, connect-string Details | V1 | Epic 6, 7 |
| **Share users** | `getent`-backed identities, nologin share users, SMB passwords | V1 | Epic 8 |
| **Jobs & notifications** | menu descoped; **unattended-run notifications (9.4)** shipped on the pve-notify client | 0.2.10 | Epic 9 |
| **Setup & packaging** | release tarball + transactional `install.sh`, semver single source, Actions release on tag | V1 | Epic 10 |
| **AHR** | ANAS Hybrid RAID — md→LVM→btrfs mixed-size pools, online expansion, spares, re-add, btrfs snapshots, notifications, dashboard parity | 0.2.x headline | Epic 11, `AHR-DESIGN.md`, `AHR-GROUND-TRUTH.md` |
| **Multi-node** | central instance OBE; **12.1 version-skew banner**, **12.2 API through `:8006`** shipped | V1 / 0.2.0 | Epic 12, `PROXY-TRANSPORT-DESIGN.md` |
| **PVE UI embedding** | native ExtJS panels (Ceph model), gateway forwards per node, cache-busted bundle | V1 | Epic 13 |
| **Visual language (gfx)** | `ANAS.gfx` — SVG objects, composer, topology, enriched trees, telemetry charts | V1 → 0.2.10 | Epic 15 |
| **Backup (PBS)** | repositories (incl. PVE's PBS storages), tasks as systemd units, Backup menu, cadence + biweekly parity, retention/prune, notifications | 0.1.x → 0.2.10 | Epic 16 |
| **Schedules** | uniform ZFS/AHR schedules, hold-safe retention, Snapshots + Scrubs menus, last-scrub verdict, run/stop | 0.2.x | Epic 17, `SCHEDULES-DESIGN.md`, `SCHEDULES-GROUND-TRUTH.md` |
| **Mounts** | remote NFS/CIFS as a client, verb ladder, inventory with hands-off tagging | V1 → 0.2.12 | Epic 18 |
| **iSCSI** | LIO targets/LUNs (zvol + AHR image), serial persistence, boot ordering + restore-hole/stub health, cross-feature hold gates, firewall advisory | 0.3.0 | iscsi epic (HISTORY §0.3.x) |
| **Backup phase 2** | snapshot-consistent backups (ZFS + AHR), file/LUN restore, boundaries, per-run notifications | 0.3.0 | backup2 epic (HISTORY §0.3.x) |
| **Self-heal (AHR)** | scrub attribution, csum-arbitrated repair engine + job, mirror reconcile, DUP-metadata correction counts, decision tree | 0.3.0 → 0.3.2 | selfheal epic, `AHR-SELF-HEAL-GROUND-TRUTH.md` |
| **Identities fixes** | mixed-case names, SMB entry dropped before `userdel`, delete grids reload on failure (#60) | 0.3.2 / 0.3.3 | identity.1–2 |

Releases: github.com/ccebelenski/anas/releases — every release ships hand-written notes.

---

## 2. Standing rulings (binding)

One line each. These are decisions, not history; the rationale is in `EPICS-HISTORY.md` under the epic named. A change that conflicts with one of these stops and gets discussed first. (`PRINCIPLES.md` and `DESIGN.md` sit above this list. Parenthesised numbers are `EPICS-HISTORY.md` stories.)

### Cross-cutting
- **Never build a scheduler.** systemd timers are the mechanism and **the units are the store** — with one caveat (live-proof F9): systemd garbage-collects a DISABLED unit's run history, so a disabled task has no durable last-run at all; status derivation reports `disabled` and the detail says history is not retained while disabled (`anas-repl-*`, `anas-snap-*`, `anas-backup-*`; `Persistent=true`; no second config source; the runner is a dumb conduit that POSTs the daemon job and exits truthfully). *(5.5, 16, 17)*
- **journald is forensics, never correctness.** Authoritative state comes from the system itself (ZFS/btrfs/md state, systemd unit + timer state, config files); journald supplies recent detail, labeled as such. No ANAS-written state files. *(5.5, 16, 17 stage 5)*
- **One menu per feature; actions live on the grid toolbar; detail windows are display-only.** No row-icon action columns. *(9, 11 refinement, 15.4)*
- **Dashboard shows only running ops (jobs strip) and failures/overdue (warning cards).** Healthy/idle shows nothing. Healthy AHR pools do get structural presence like ZFS pools (11.13). *(2, 5.5, 16.7, 17.7)*
- **Notifications go through PVE's notification system only**, via the one `pve-notify.ts` client and shipped `.hbs` templates. Per-task `notify: always | on-failure`; **default `always` for backup (vzdump parity), `on-failure` for snapshots and replication**; skips never notify; bodies are plain ASCII facts with no commentary; delivery is best-effort and never fails the run. **Overdue is PULL (dashboard), never a push.** *(9.4, 11.4, 16.12)*
- **PVE territory is read-only and hands-off.** `storage.cfg` is parsed, never written; PVE-managed pools/datasets/mounts (and zvols) are tagged and untouchable; `/mnt/pve` is reserved; PVE's content-typed artifact-store paradigm is never replicated. *(3.25, 18)*
- **Version skew: additive, optional fields; warn, don't fail.** A new UI against an old daemon renders today's screen; the skew banner names the versions. *(12.1, 11.19)*
- **Secrets:** per-item root-only 0600 files under `/etc/anas/creds/` (mounts, PBS repos); **write-only through the API**; never argv, never journald, never inline in a config file. PVE-held secrets are read at exec time, never copied. *(16.2, 16.8, 18.5)*
- **Cluster-wide registries live in pmxcfs** (`/etc/pve/anas/*.json`, `/etc/pve/priv/anas/*`) with **CAS versioning** (`version`/`updatedBy`; 409 on a stale write). Per-node artefacts (mounts, tasks, units) stay local. *(5.5.2, 16.2, 18)*
- **Guide, don't just warn.** Busy errors name the holding processes (`busy-diagnosis.ts`, spans ZFS/AHR/mounts, fail-open); test-connection endpoints DIAGNOSE (dns / tcp / tls / auth / not-found) rather than fail; refusals say what to do next. *(3.29, 5.5.2, 16.6, 18.5)*
- **Safety altitudes:** 409 + confirm code for data-destroying ops; a hard 409 with no bypass for ops that are unsafe *now* (busy resilver/reflow, degraded array); an **advisory amber commit-gate** ("review to continue") for waste-not-loss — never block, warn-and-confirm. *(3.31, 11.6, 11.16, 3.30)*
- **A live initiator is never yanked (operator ruling 2026-08-26):** an iSCSI target with live sessions cannot be deleted (409, no bypass — log the initiators out first), a target can only be deleted once it has NO LUNs (delete them first; their backing stays unless `destroyBacking` is chosen per LUN), and a LUN in use by a session cannot be deleted. Disconnecting a client is not something to confirm — it is a state to refuse.
- **Parallel construction:** ZFS and AHR function alike; divergence only where the technology differs, and then stated in the UI. Sanctioned divergences: md keeps no scrub completion record (honest absence); AHR scrub has no Stop; AHR members are partitions (full by-id shown, never truncated). *(11.18, 17 stage 5/6)*
- **Ground truth first:** capture real command output before writing a parser; fixtures are labeled real capture vs synthetic; live-prove on the stunt node (including failure paths) before release; never against the operator's real PBS/TrueNAS. **A mutation job that runs two or more system commands in sequence is live-proven on the stunt node as a matter of course, success AND each failure step, before it ships** (ruled 2026-09-20 after #60: the fake executor cannot know that `smbpasswd -x` depends on the account `userdel` just removed, and it cannot catch a fall-through where a failed step is reported as success — the unit test asserted the wrong order and passed). A unit test proves the argv; only the stunt node proves the sequence. *(every epic)*
- **Dialog ↔ daemon contract:** for every option, value / `null` / omitted mean set / clear / keep; an untouched edit rewrites byte-identically (pre-fill reflects the entry exactly, never field defaults); fields are read by itemId, no hiddenfield mirroring. *(#34, #43, #26)*
- **Structured output only** (`-j`, `--output-format json`); never parse human tables when a structured form exists. *(Principle 13)*
- **Ids are never truncated; numbers carry labeled context.** *(11.18, 15.6)*

### ZFS — pools, datasets, snapshots *(Epics 3/4/5)*
- Shares are storage-agnostic: **a path is a path** (smb.conf / exports edited directly, never `sharesmb`/`sharenfs`); only filesystem datasets are shareable. *(DESIGN §5a)*
- Pool root dataset is first-class on ANAS-managed pools; view-only on PVE-managed ones (a recursive root snapshot there would sweep PVE's zvols). *(3.26)*
- Special/dedup vdev redundancy is **enforced**, not advised; `special_small_blocks` exposed. *(3.22)*
- **One disk per attach**; RAIDZ expansion gated on OpenZFS ≥ 2.3.0 + `feature@raidz_expansion` (guiding 409); honest realized-capacity estimate shown; `autoexpand=on` default at create; `zpool online -e` after a larger-disk replace (never flip a pool's autoexpand). *(3.31)*
- No default pool name; mountpoint is a ZFS property, never fstab; the same collision checks as AHR. *(3.27, 3.28)*
- Permissions editor is **POSIX ACLs** (`acltype=posixacl`, `acl` package); NFSv4 ACLs deferred to Epic 14. *(4.7.2, 4.7.1)*
- Dedup lives behind an advanced, RAM-cost-stated control; `sync=disabled` carries a data-loss warning. *(4.10, 4.12)*
- Dataset encryption: deferred until a user asks (key management is the work; PVE has no precedent). *(4.11)*

### Replication *(Epic 5.5)*
- Remote needs **sshd + ZFS only** — nothing is ever installed there; push-only; TrueNAS works as a target.
- Two peer tiers: cluster peers auto-discovered from `/etc/pve/.members`; external remotes registered. One cluster-wide keypair at `/etc/pve/priv/anas/replication_key`; pinned host keys, fingerprint confirmed once (no silent TOFU).
- Destination `readonly=on` by default; `recv -F` behind the confirm gate; a FULL send is announced with its size; **`zfs hold` on the incremental base**; the newest common snapshot IS the durable record. `zfs allow` delegation is a noted follow-on, not faked.

### Shares & identities *(Epics 6/7/8)*
- Surgical config editing with comments/order preserved and byte-identical round-trips; `reload smbd` / `exportfs -ra` are side effects of mutations, never separate calls; an SMB interface-binding change is confirm-gated when clients are connected.
- Identities resolve via **`getent`/nsswitch, never `/etc/passwd`** (the Epic 14 seam). ANAS-created users are nologin share users (`useradd -M -s nologin`), never PVE users; `user.cfg` is never written. **User delete is OUT** — disable is the primitive (UID recycling / orphaned ACLs); unresolved owners are flagged, not hidden.

### AHR — ANAS Hybrid RAID *(Epic 11)* — design: `AHR-DESIGN.md`
- Stack: size-matched partitions → **one md array per band (RAID5 = AHR-1 / RAID6 = AHR-2; redundancy lives here)** → LVM concatenation → **btrfs as the filesystem, never btrfs-RAID5/6**. ext4 dropped. No tier conversion.
- Fresh-create banding ≠ expansion: existing bands are immutable constraints; grow with ≥ the largest disk; backup-file-free reshapes only; resume = recompute-and-continue with only the approved disk set persisted; `mdadm --replace` for live replace; arrays carry `--bitmap=internal` (re-add rides it).
- Spares are full-coverage only (partial refused with the exact shortfall); md owns automatic failover; promote-to-member and shared spares OUT.
- Snapshots: `@data`/`@snapshots` subvolume layout; rollback preserves the replaced state as `pre-rollback-<ts>` and destroys nothing; flat pre-layout pools report `subvolLayout:false` with **no in-place migration** (destroy/recreate is the migration).
- Notifications discriminate check vs rebuild (`last_sync_action`, bad-block list); **recommend a scrub, never enforce one**; auto-scrub-after-rebuild rejected.
- Everything keyed by-id/UUID; device names resolved at point of use.
- **Cache tier = lvmcache `--type cache` in WRITETHROUGH only** (read cache; GitHub #63, ruled 2026-09-21). Writeback and `--type writecache` are rejected: dirty blocks exist nowhere but the SSD, a cache-device loss loses data, and both cross the self-heal boundary (repair reasons at md, below LVM). A writethrough cache never holds the only copy, so a missing cache device is dropped automatically at boot (`--uncache` + `vgreduce --removemissing`) and the pool comes up uncached — no data at risk by construction.
- **iSCSI LUN image files on AHR stay copy-on-write** (ruled 2026-09-11): no `NOCOW`/`chattr +C`, no per-LUN toggle. NOCOW drops the btrfs data checksum for exactly the object where corruption is hardest to notice, puts it outside scrub attribution and self-heal, and snapshots (every backup run, every schedule) defeat it anyway — first write after a snapshot is CoW-once, so the file fragments regardless. Guidance is placement, not a flag: random-write block workloads → zvol. Reopen only if CoW proves harmful generally, never for one workload.

### Backup via PBS *(Epic 16)*
- A task = repository ref + namespace + **`backup-id`** (explicit, logical; hostname only the default) + **1..N archives** `{name, path, excludes[]}` — names/paths are explicit config, never derived. Excludes are config, `.pxarexclude` is respected.
- Repositories: two tiers — **PVE's `pbs` storages auto-discovered** (secret read from `/etc/pve/priv/storage/<id>.pw` at exec, never copied; PVE-badged, not editable) and ANAS-registered ones (token recommended, password supported; fingerprint pinned with one-time confirmation).
- **ANAS never contacts the PBS server for status or monitoring.** Sanctioned contacts: the backup run itself, the explicit repository Test, the save-time namespace verify, the post-success prune and its user-initiated preview — and, from phase 2, **user-initiated restore operations** (snapshot listing for a restore, `catalog shell` browsing of an archive, the restore itself). Never polling, never background. Server-side history/verify belongs to the PBS UI.
- Run Now goes through the task's own unit (one code path, one history). fd cap via `prlimit --nofile` around the client exec (per-task, default 1024).
- Cadence: weekly / **biweekly with EXPLICIT ISO-week parity** / monthly / custom OnCalendar; an off-week fire is a visible `skipped (off week)` (exit 75, unit success); heal rule: run regardless when the last success is > 14 days old; Run Now bypasses the gate; overdue is cadence-aware.
- Retention: absent policy ⇒ ANAS never prunes; prune runs after a SUCCESSFUL run with exactly the configured `--keep-*`; a prune failure never fails the job (warnings); **GC stays PBS-side**.
- `--change-detection-mode` is a per-task choice with honest guidance. Client-side encryption is a v1 non-goal (door left open via the env contract).
- Mounted drives and any path are first-class sources; snapshot-consistency is a **per-source capability** (phase 2 builds it — until then every backup is a live backup, and the UI must say so).

### Schedules — snapshots & scrubs *(Epic 17)* — design: `SCHEDULES-DESIGN.md`
- ANAS manages snapshot schedules itself (sanoid dropped: ZFS-only, could not be uniform across AHR): one timer per schedule, keep-N bucketed retention, `zfs snapshot` / 11.12 btrfs primitives underneath.
- **Retention respects holds:** held snapshots are excluded up front, re-checked before each destroy, and surfaced as `skippedHeld` — skip-and-surface, never try-and-warn.
- Scrubs stay filesystem-native and are **surfaced + toggled, never double-scheduled**: ZFS = `org.debian:periodic-scrub` property (PVE's monthly cron); AHR = mdcheck timers (node-global, stated). Last scrub: ZFS from `zpool status` scan stats; AHR honest absence. Run/Stop are second doors to the existing verbs; Stop is ZFS-only.

### Mounts *(Epic 18)*
- **Remote NFS/CIFS only** (`MountType` = nfs|cifs; the daemon 400-rejects mutations on local filesystems). Local/removable drives and single-disk formatting are not ANAS's problem — a local disk's path into ANAS is a ZFS pool or an AHR pool.
- Pure management: ANAS writes fstab and calls `mount`/`umount`; the systemd fstab generator does the work; configured = the fstab line, actual = `findmnt`. `nofail` forced; boot mount is the default, automount a per-mount toggle.
- **The hang trap:** the daemon never touches a mountpoint synchronously — liveness via `timeout 2 stat -f`; an armed automount takes its identity from its fstab entry.
- Verb ladder: *unmount* (kernel state now) / *disable* (`#ANAS <verbatim>` marker, credentials kept, byte-identical re-enable) / *delete* (entry + credentials gone). Options: structured common tiers + verbatim passthrough for the long tail.
- Mountpoint must be an empty dir, never under `/mnt/pve`; unmount cross-checks shares and backup tasks riding the path.

### UI & packaging *(Epics 13/15/10/12)*
- Native ExtJS panels injected into the PVE UI (Ceph model); `anas` is a pure API gateway forwarding `/api/nodes/<node>/v1/*` with the user's ticket over cluster-CA TLS; served through PVE's `:8006` via a fail-open pveproxy hook (`PROXY-TRANSPORT-DESIGN.md`). Fail-open everywhere: a broken ANAS never breaks the PVE UI.
- `ANAS.gfx` is the one shared visual layer: SVG + DOM (never canvas), disk/vdev objects, gauges, drag toolkit, `timeChart` (**1-2-5 binary ladder + ratchet-up-only, operator re-fit, single-vdev collapse with member tiles never collapsed, labeled short-window averages, hatched unsampled region**).
- Distribution is the release tarball + transactional `install.sh` (preflight → install → health → rollback on failure); dependencies an ungated feature needs are installed (samba/nfs/mdadm/btrfs-progs/acl…); semver has one source (`bump-version`); **releases are cut by the Actions workflow on a `vX.Y.Z` tag and always carry hand-written notes**. No yaml config layer; overrides are env/unit drop-ins.

---

## 3. Active — 0.4.0

> Shipped 0.3.x stories (backup2, iscsi, selfheal, identity) moved to `docs/EPICS-HISTORY.md` §"0.3.x shipped" on 2026-09-21; their rulings that outlived them are in §2.

### 0.4.0 — accepted 2026-09-14 (operator: "a full and solid release"); groomed 2026-09-21

> Theme: the NAS reaches out, boots the fleet, and serves its clients' history. Stories below are AUTHORIZED in scope; each still gets its detailed story text (and PXE its design pass) before dispatch.
>
> **Dispatch order (grooming 2026-09-21):** user-driven stories first — `pvepool.1` → `smbsvc.1–3` → `rclone.1` → `ahrcache.1` — then `backup2.11`, `disks.1`, `ahrexpand.1`; `pxe.1` last. No version was promised on any issue (§2 rule); the issues stay open until their story ships.
>
> **Riders (ticks, not stories):** the add-LUN dialog's AHR-backing branch gets a one-line note — *image is checksummed and CoW; prefer a zvol for random-write workloads* (the 2026-09-11 CoW ruling, §2 AHR).

**rclone.1** Cloud sync via rclone (GitHub #57) — one-way copy/sync of a dataset or share path to an rclone remote on the schedule-unit pattern; rclone installed as a dependency like samba; remotes configured through ANAS with secrets held like backup credentials (0600, write-only); a job + notification per run; no cloud-vendor APIs, no two-way sync, no restore UI in the first cut.

**pxe.1** PXE boot images — DESIGN FIRST (own session): images stored on a dataset, served by wiring up existing tools (dnsmasq proxyDHCP + TFTP, HTTP for UEFI boot), an iPXE menu generated from what is on the share; proxyDHCP ONLY, never own DHCP; scoped per bridge; two uses: (a) VM installers/live images, (b) other PVE nodes — the Proxmox installer with an answer file served over HTTP (automated install of a new/replacement node from the NAS) and a rescue image (the bare-metal end of DR). The node hosting ANAS cannot netboot from itself. **Slips to 0.5.0 if the release is otherwise ready** (grooming 2026-09-21): the one story with no user demand behind it and a design pass in front of it.**smbsvc.1** Snapshot self-service on SMB shares — Previous Versions via `vfs_shadow_copy2` over the existing snapshot schedules (snapshot-name contract to settle) + **smbsvc.2** a recycle bin via `vfs_recycle` (purge policy to settle); per-share checkboxes; surgical smb.conf edits. **smbsvc.3** Time Machine target — a per-share checkbox (`vfs_fruit` + `fruit:time machine` + a forced size cap), no avahi in v1; folded in because it is the same Samba vfs family.

**backup2.11** Backup source guard — a backup pre-flight refuses an archive path on a configured-but-unmounted mount (the 2026-08 boot-race incident); the facts are already in the inventory.

**disks.1** Periodic SMART re-probe — measured disks are probed once per daemon lifetime today; re-probe on a bounded cadence honouring `-n standby` (never wake a disk), so health and the standby/stale marks stay current. **Ride-along:** a read-only power-mode row in the disk detail panel — the ATA identity call already returns `power_mode` for free (2026-09-10 ruling; display only, no policy).**pvepool.1** Sibling datasets on a PVE-managed pool (GitHub #61, ruled 2026-09-20) — relax the 3.25 per-pool-root tag to PVE's actual footprint, read from `ZFSPoolPlugin.pm` on PVE 9.2: the configured `pool` path (which may be `<pool>/<dataset>`) plus its DIRECT children named `(vm|base|subvol|basevol)-<vmid>-*` (`zfs list -d1` + that regex; everything else is dropped from PVE's inventory, and a default install already keeps `rpool/ROOT` beside `rpool/data`). Rules: PVE's subtree is never touchable AND never selectable anywhere (no share, no snapshot, no picker entry); ANAS refuses the guest naming pattern for anything it creates at that depth; ordinary datasets elsewhere on the pool are allowed; picking a PVE-managed pool in the create-dataset dialog shows an INFORMATIONAL note (I/O contention with guests; PVE's free-space number shrinks by ANAS's usage), never a blocker; a switch that manages the whole pool stays a no. Reopens every 3.25 consumer (pools mountpoint guard, datasets, mounts, iSCSI ownership, backup pre-flight) as a scoped re-examination; re-read the plugin on the target PVE version before dispatch (the regex and `-d1` are the contract). **Ride-along:** the volume create dialog states the ZFS default `volblocksize` (iscsi.3) but says nothing about raidz — add the one-line hint that small volblocksize on raidz wastes space to parity/padding (fact, not a recommendation of a number).**ahrcache.1** AHR read cache (GitHub #63, accepted 2026-09-21; design `AHR-DESIGN.md` §13) — lvmcache `--type cache --cachemode writethrough` (smq) on the pool's existing VG: one or more non-rotational disks, each one GPT slice → PV → one cache volume LV (`--cachevol`, linear across the SSDs, no redundancy needed — nothing lives only there) → `lvconvert` of the pool LV. Attach/detach as jobs on an EXISTING pool (post-create only; the composer is untouched); detach is data-harmless, no confirm code. Pool detail gains a `cache` block from `lvs --reportformat json` (devices, size, hits/misses, used/dirty blocks) + SSD wear where the drive reports it (NVMe `percentage_used` is standard; SATA wear attributes only when present, never inferred — firmware bar). Topology classifies a non-md PV in the VG as `cache` (not an anomaly) and handles the hidden `_corig`/`_cvol` sub-LVs; the cache disk is in-use (role `cache`) and out of every composer/spare/expand candidate list via the shared predicate; destroy wipes it too. **Boot rung:** cache PV missing → `lvconvert --uncache` + `vgreduce --removemissing` + activate, notification + dashboard warning "running uncached" (the md degraded-but-up parallel). Advisory text states the two facts once: hotspot cache (sequential I/O bypasses), SSD is a consumable. GT 2026-09-21 (stunt node, lvm2 2.03.31, loop devices): `lvextend` on the cached origin works while mounted + btrfs resize follows (expansion pipeline unchanged); missing cache PV = activation REFUSED in normal/degraded mode and partial mode fails — recovery above verified, data intact. **Open GT before dispatch:** cache SSD failing while the pool is LIVE (dm-cache does not bypass on error; expect I/O errors until uncached — decide the runtime response), telemetry sampler's dm resolution once the pool LV is a cache target. Live proof per the §2 sequenced-mutation rule: attach, detach, grow-while-cached, boot with the SSD missing, destroy.

**ahrexpand.1** Zero-gain expand guard (candidate since 2026-08, ruled 2026-09-21) — an AHR expansion plan whose reachable target adds no usable capacity (the §5.2 "pending capacity" shape: one disk replaced above a band boundary, or a disk set the planner cannot use) is refused up front with the guiding 409 that states the exact shortfall and what unlocks it ("replace one more disk with ≥ N TB to unlock ~M TB"), instead of a sub-second "success" that did nothing. A confirm-code bypass is allowed for the honest zero-gain cases an operator may still want (a replace for a failing disk of the same size). UI-facing safety gate on a dangerous op, so it keeps full weight (§2 API-for-UI rule). Plan-time only; the executor is untouched.

## 4. Candidates (serious; not authorized)

One paragraph each. Promotion to §3 is an operator call.

- **Local-snapshot file restore** *(decoupled from Backup phase 2, 2026-08-25)*: the `backup2.5` picker over `.zfs/snapshot/<s>/` and AHR ro snapshots, copying selected files back without a rollback. No backup client involved — "just files". Its own small epic when wanted.
- **Ceph RGW / S3**: surface the object gateway PVE installs but never exposes — ANAS's purest "thing PVE doesn't do". Candidate epic.
- **Lean HA / event-driven replication**: near-term, replication triggered off the ZFS `written` counter (idle disks stay asleep); later, a 2-node quasi-HA without Ceph (SMB msdfs, NFS keepalived VIP) — async, bounded RPO, never sold as true HA.
- **Policy-based tiering (3.24)**: scheduled, auditable data movement between fast and capacity tiers inside a pool. Own epic; the vdev/composer work is its prerequisite.
- **Dataset encryption (4.11)**: key management (passphrase/keyfile, load/unload, change-key). Deferred until a user asks.
- ~~AHR boot-ordering anchor for iSCSI~~ → **promoted into `iscsi.8`** (2026-08-26, after live-proof F2 showed the real failure mode is a silent empty disk, not a missing LUN). Was: AHR pools mount from fstab with `nofail`, so no static `After=` can order `rtslib-fb-targetctl` behind them; the right mechanism is `x-systemd.before=rtslib-fb-targetctl.service` on the AHR fstab line (`ahr-create.ts`) plus a migration for existing pools. Until then a file-kind LUN on an AHR pool may restore before its pool at boot — surfaced by the `iscsi` health card and repairable.
- **AHR read-time corruption counters on the dashboard pull** *(replaces the rejected journal watcher, 2026-09-21)*: `btrfs device stats` keeps per-device `corruption_errs`/`read_errs` counters, incremented on read-time checksum failures as well as scrubs — structured, read on the existing dashboard pull, zero resident cost; non-zero → the same PVE warning the scrub emits ("run a scrub"). The ZFS parallel is the `CKSUM` column already shown. Cheap; demand-gated.
- **Enclosure / physical-path topology** in the disk picker and topology view (by-path USB bus), so fault-domain spread is visible at compose time.
- **Directory services (Epic 14) (AD/LDAP via realmd/winbind/sssd) + NFSv4 ACLs (4.7.1)**: enterprise; deferred until demand. The `getent` seam keeps it a drop-in.
- **Shelved, demand-gated (don't re-raise unprompted):** scrub history page; Disks-tab pool→band hierarchy (needs a tree panel); `.deb` packaging + apt repo; data mover (mc-shaped dual-pane, moves-as-jobs).
- **Napkin only (not roadmap):** "Boost" sync priority + the OS-tuning boundary rule; AHR in-place rebalance (riskiest op we could ship — honest paths stay create-time-mix or grow-with-≥largest).

---

| Cloud sync via rclone (#57) | **Accepted for the release after 0.3.2** — one-way copy/sync of a dataset (or share path) to an rclone remote on the schedule-unit pattern; rclone installed as a dependency like samba; remotes configured through ANAS with secrets held like backup credentials (0600, write-only); notification per run; NO cloud-vendor APIs, NO restore UI (rclone copy-back is the operator's), NO two-way sync in the first cut. Offsite PBS backup remains the PBS S3 datastore path. | #57 |

## 5. Rejected / OBE (don't re-derive)

| What | Why | Ref |
|---|---|---|
| PAM/fallback login, session expiry, logout, auth auto-detect | PVE owns the session; ANAS is only reached through PVE | 1.x |
| Dedicated Jobs menu / job history / job detail | Jobs are ephemeral by design; feedback is feature-native + dashboard; audit is journald | 9.1–9.3 |
| `npm install -g`, `anas setup`/`doctor` CLI, yaml config layer | Tarball + transactional `install.sh` is the install path; preflight is the doctor; overrides are env/drop-ins | 10.x |
| iframe embedding of a Vue/Nuxt app | Style clash reads as a foreign app; native ExtJS panels (Ceph model) instead | 13.1–13.3 |
| Central multi-node ANAS instance over TCP | Per-node install + routed gateway (the Ceph model) shipped instead | 12 |
| Local-disk mount/format, removable-drive handling | "A NAS layer, not a layer over Linux"; local disks become ZFS/AHR pools | 18.4/18.6/18.7 |
| `sanoid` as the schedule engine | ZFS-only; could not be uniform across AHR | 17 |
| Our own scheduler / poller / overdue push | Principle 7; systemd timers + dashboard PULL | 5.5, 9.4, 16.12 |
| User delete | Orphans ownership, UID recycling; disable is the primitive | 8 |
| Auto-scrub after an AHR rebuild | Recommend, never enforce a many-hour op | 11.17 |
| Content browser / file manager | Not ANAS; the picker is a selector only | data-mover idea |
| qcow2-backed LUNs | Unique but low value; needs a daemon per LUN; tiers 1+2 suffice | iscsi (2026-08-25) |
| LV-backed LUNs on AHR | Outside AHR's btrfs data model; file-on-btrfs is the AHR block object | iscsi (2026-08-25) |
| AHR write cache (dm-cache writeback, dm-writecache) | Dirty data only on the SSD = data loss on its failure; crosses the self-heal boundary; writethrough read cache is the accepted shape | #63 (2026-09-21) |
| Journal watcher for btrfs checksum errors at read time | Kernel btrfs lines are unstructured — a resident `journalctl -f` regex over every kernel line, forever (open-ended fuzzy match, resource consumer); `btrfs device stats` counters on the dashboard pull answer the need structured | selfheal (2026-09-21) |
| PVE "ZFS over iSCSI backend" wizard / `pvesm` snippets | ANAS is the target side only; PVE is an ordinary initiator | iscsi (2026-08-25) |
| Content types / `storage.cfg` writes | PVE territory is read-only, always | 18 |
| UI auto-refresh after upgrade (#31) | PVE parity: PVE's own UI needs a hard reload too; skew banner + notes advisory suffice | #31 |
| TODO-list / dev-process issues on GitHub (#45) | Public issues are for real bugs; follow-ups tracked locally | #45 |
