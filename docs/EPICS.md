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

Releases: github.com/ccebelenski/anas/releases — every release ships hand-written notes.

---

## 2. Standing rulings (binding)

One line each. These are decisions, not history; the rationale is in `EPICS-HISTORY.md` under the epic named. A change that conflicts with one of these stops and gets discussed first. (`PRINCIPLES.md` and `DESIGN.md` sit above this list. Parenthesised numbers are `EPICS-HISTORY.md` stories.)

### Cross-cutting
- **Never build a scheduler.** systemd timers are the mechanism and **the units are the store** (`anas-repl-*`, `anas-snap-*`, `anas-backup-*`; `Persistent=true`; no second config source; the runner is a dumb conduit that POSTs the daemon job and exits truthfully). *(5.5, 16, 17)*
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
- **Parallel construction:** ZFS and AHR function alike; divergence only where the technology differs, and then stated in the UI. Sanctioned divergences: md keeps no scrub completion record (honest absence); AHR scrub has no Stop; AHR members are partitions (full by-id shown, never truncated). *(11.18, 17 stage 5/6)*
- **Ground truth first:** capture real command output before writing a parser; fixtures are labeled real capture vs synthetic; live-prove on the stunt node (including failure paths) before release; never against the operator's real PBS/TrueNAS. *(every epic)*
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

## 3. Active — 0.3.0

> **Headline: iSCSI (block storage) + Backup phase 2 (snapshot-consistent backups and restore).** Two independent chains: iSCSI's core needs nothing from Backup phase 2; only LUN backup/restore (`backup2.4`/`backup2.7`) joins them. Staged like 0.2.10 — dev builds deploy to the fleet as stories land; the release is cut when everything is live-proven. File restore (`backup2.5`/`backup2.6`) is the severable piece if the release drags.
>
> Riders: **#46** (recurring replication task validates the target pool locally for a remote location); the **`ANAS.editGuard` dedupe** (identical save-gate copies in `65-replication.js` and `69-snapshots.js` → one helper in `10-api.js`, single-source rule).
>
> Attention notes marked **⚠** came from the 2026-08-25 design review; the five that bite hardest if missed: LUN serial persistence (`iscsi.2`), target boot ordering (`iscsi.5`), initiator reconnect during a block restore (`backup2.7`), replication's base-snapshot discovery vs the transient backup snapshot (`backup2.3`), the FUSE hang trap in archive browsing (`backup2.6`).

### Backup phase 2 — snapshot-consistent backups, boundaries, restore *(continues Epic 16)*

> Epic 16 shipped every backup as a **live** backup (the snapshot step was designed and never built) and shipped **no restore** — the client has `restore` (whole or `--pattern`-selective, explicit `--overwrite*` flags), `mount` (FUSE browse), `map`/`unmap` (`.img` → loop device). Restore is wiring, not building. Two restore *types*, by nature: **files are selective; block images are whole.**
>
> **Decoupled, not here:** file-level restore from *local* ZFS/btrfs snapshots (no PBS client involved — its own future thing, §4).

##### Dev (ground truth first)
**backup2.1** `[done 2026-08-25]` As a dev, I want ground truth on a disposable PBS + the stunt node before code — so every parser and verdict is built on reality. **Result: `docs/BACKUP-RESTORE-GROUND-TRUTH.md` (62 facts) + 24 real fixtures under `fixtures/backup/` (client/server 4.2.5).** Headlines: metadata-mode continuity across the live→snapshot switch HOLDS (inodes identical, `had to backup 0 B`); `restore` refuses every existing target incl. block devices (`--overwrite` does not help) — devices are written via stdout (`restore … -`) or `map`+`dd`; a size mismatch is unguarded and destructive (writes until ENOSPC); a regular file is a first-class `.img` source; `--change-detection-mode` is a no-op for `.img`; `--pattern` is suffix-matched unless anchored with `/`, `[` unescaped silently matches nothing, a no-match is a silent success; FUSE `mount` daemonizes, a dead PBS yields fast `EIO` while a black-holed one leaves readers in D state that `timeout` cannot kill (`/sys/fs/fuse/connections/<N>/abort` is the only lever) and `stat -f` reports the dead mount healthy; **`catalog shell` is a scriptable non-FUSE browser (`ls`/`stat`/`find`/`select`/`restore-selected`) over a pipe**; a btrfs ro snapshot drops nested subvolumes with no client flag to recover them; `snapdev` restore is `zfs inherit`, not `set hidden`; a killed restore leaves a partial tree with no marker (in-flight file is `0600`); a bare group path restores the LATEST snapshot silently.

##### Enhancement — filesystem boundaries are visible, never silent
**backup2.2** `[open]` As a user, I want nested filesystems under a backup source **detected, shown, and chosen — never silently skipped**: the wizard and the task detail list every nested filesystem under a source with its kind (child dataset, btrfs subvolume, local disk, NFS/CIFS mount, pmxcfs); a per-archive **`includeNested: none | all | [paths]`** (→ the client's default / `--all-file-systems` / one `--include-dev` per path); an alert when the current choice would back up a nested filesystem as an empty directory; and the client's `skipping mount point:` lines parsed into run warnings — so an omission is on the record, not in a log nobody reads. **Default = `none`** (the client's own; PVE's lead). *(GT: **detection is an `st_dev` walk of the tree, not `findmnt`** — btrfs subvolumes are not mounts but carry their own `st_dev` (GT btrfs: `@data`=66, `@data/photos`=67), and that is exactly what the client keys on; `findmnt` then names what the walk finds. Exclude `.zfs/snapshot` automounts; treat autofs placeholders as the mounts family does. Absent = `none`, and the edit dialog shows it as absent — never writes a default on an untouched save. Own detection is the authoritative warning; the log parse is secondary. Product-level example: backing up `/etc` today silently omits `/etc/pve`. **Ruling 2026-08-25:** an uncovered nested filesystem makes every run "completed with warnings" — so the 16.12 notification reads `warning` until the operator chooses `none` / `all` / paths — accepted for the first release as the never-silent intent; the mail stops the moment a choice is made. `all` resolves at run time to per-archive `--include-dev` flags, never `--all-file-systems`, which is per-invocation and would spill onto sibling archives.)*

##### Snapshot-consistent backups
**backup2.3** `[open]` As a user, I want ZFS- and AHR-backed sources backed up **from a snapshot** — snapshot → back up from the snapshot path → destroy — so a multi-hour run captures one instant, with sources that cannot be snapshotted (remote mounts, foreign filesystems) backed up live and **labeled live**. *(Consistency is derived per source from its capability, shown in the wizard and the run result.)* **Reuse, don't re-implement:** `zfs snapshot` is already invoked in two places (`routes/datasets.ts`, `services/snapshot-schedules.ts`) — extract ONE helper first and make backup its third caller; AHR goes through `createAhrSnapshot`. **Nested filesystems force the shape on BOTH backends:** recursive snapshot → **one archive root per dataset / subvolume, expanded by the runner at run time** from the single stored source (deterministic names, e.g. `data` + `data__photos`, within PBS's archive-name charset; the wizard says "N nested filesystems → N+1 archives"); a plain subdirectory source maps to `<dataset>/.zfs/snapshot/<s>/<relative>`; excludes apply per expanded root. *(GT: a single `btrfs subvolume snapshot -r` of `@data` leaves every nested subvolume as an EMPTY placeholder and `--all-file-systems` cannot rescue it — so per-subvolume expansion on AHR is a correctness requirement, not an option; same for ZFS children.)* The `backup2.2` matrix is explicit: nested snapshottable filesystems = expansion; non-snapshottable nested mounts = live-labeled or skipped, per the option. **Lifecycle:** transient `anas-backup-<task>-<ts>` snapshots are destroyed in `finally`, a stale-prefix sweep runs at every start (recursive), **no holds**. ⚠ **Replication's newest-common-snapshot discovery and Schedules retention must ignore the `anas-backup-*` prefix** — otherwise a transient becomes an incremental base and its destroy breaks the chain. *(GT: continuity is PROVEN — inodes are identical live vs `.zfs/snapshot/<s>/`, metadata mode reports the tree unchanged after the switch (`had to backup 0 B`), both directions; `.zfs/snapshot/<s>` is reachable with `snapdir=hidden` and is a real `findmnt` entry.)*

##### Block images
**backup2.4** `[open]` As a user, I want a backup archive of kind **`img`** beside `pxar` — a block device or a raw image file backed up as a fixed-chunk image (the client's `.img` type) — so an iSCSI LUN (iSCSI epic), either backing kind, is a source in the same task wizard, on the same timers, with the same prune/notify/dashboard. *(GT: a regular file is a first-class `.img` source — no loop device. Zvol: snapshot device via `snapdev=visible` (node appears in ~55 ms; `udevadm settle` anyway) → back up `/dev/zvol/<pool>/<vol>@<s>` (hard read-only, stable point-in-time) → restore the property with **`zfs inherit snapdev`** (a `set hidden` leaves `source=local`); image file: from the dataset/subvolume snapshot per `backup2.3`. **`--change-detection-mode` is a complete no-op for `.img`** — the wizard states that the mode does not apply and that **every run reads the full image** (unchanged run = `had to backup 0 B … reused 100%`, still a full read); upload and storage are 4 MiB-chunk-deduped. Backup of a live LUN is crash-consistent — say so.)*

##### Restore
**backup2.5** `[open]` As a user, I want a **desktop-grade directory picker** (the 16.9 known issue) — PVE's expanding-tree idiom with breadcrumb + type-ahead over `GET /v1/fs/browse` — with **two backends: the live filesystem (backup wizard) and a PBS archive (restore)** — so picking a path or a file to restore works the way a desktop does. *(A selector, not a content browser — the content browser was rejected and this does not reopen it. GT: the archive backend is **`catalog shell` over a pipe** (`ls`/`stat`/`find`, works on default AND metadata archives) — NOT a FUSE mount; the picker must show hardlink groups (`h` entries) as one unit, see `backup2.6`.)*

**backup2.6** `[open]` As a user, I want to **restore files from a PBS backup** — pick a task (or, for archives whose task was renamed/deleted, a repository + group), a point in time (`snapshot list --output-format json`, user-initiated; the caller composes `<type>/<id>/<RFC3339 time>` and **always passes the full timestamp — a bare group path silently restores the latest**), an archive, then **select anything from one file to the whole tree** with `backup2.5`'s picker; restore runs as a job via `restore --pattern …` (native extraction). **Target: a new directory beside the source by default; in-place is an explicit toggle** (→ `--allow-existing-dirs --overwrite`, the minimal in-place pair — `--overwrite` alone dies on the first existing directory; in-place is a MERGE, never a sync: foreign files survive); ownership/ACL/xattr toggles surfaced honestly (`--ignore-permissions` creates files `0600`); a space check from the manifest's `files[].size` and a **pre-flight write test on the target** (a read-only target fails only at the first file). *(GT, pattern contract: emit `/` + path with `\ * ? [ ]` backslash-escaped — unanchored patterns suffix-match at any depth, `[` unescaped matches nothing at exit 0, and a no-match pattern is a silent success, so the job verifies the restored set against the catalog and reports what did NOT restore; a hardlink's second name picked alone fails the whole job — restore hardlink groups together. **The FUSE route is rejected for browsing**: a black-holed PBS leaves readers in D state that `timeout` cannot kill and `stat -f` calls the dead mount healthy; `catalog shell` sidesteps it. The 409 confirm gate applies only to an in-place restore of a TREE; a single explicitly picked file restored in place is a checkbox (still needs `--allow-existing-dirs` when it sits in a subdirectory). LUN backing paths are protected targets, like PVE territory. Progress arrives on stderr as `\r` lines at a doubling interval (6/16/36/79 s) — the job reports "running" honestly between them. A killed restore leaves a partial tree with **no marker** — the job labels the side-by-side dir partial itself or removes it. An expanded archive whose nested filesystem no longer exists restores side-by-side with an explanation, never auto-creates datasets. Failure taxonomy captured: missing snapshot/group/namespace collapse to one message; PBS down = `Connection refused`; no-perm token has its own wording.)*

**backup2.7** `[open]` As a user, I want to **restore a LUN image from a PBS backup** — whole image, by nature — onto its zvol or image file, so a block device comes back to a point in time. *(GT: **`restore` refuses every existing target — file, zvol symlink, resolved `/dev/zdNN` — and `--overwrite` does not help.** The working paths are `restore … -` piped into the device, or `map` + `dd`; restoring to a fresh path yields a sparse file. **Size mismatch is unguarded and destructive below ANAS** — a larger image writes until ENOSPC and leaves the target half-overwritten, a smaller one leaves stale tail bytes — so ANAS compares the manifest's image size with the target's size and refuses any mismatch, stating both. ⚠ **The LUN must be disabled for the duration, not merely checked**: initiators (open-iscsi, Windows) auto-reconnect — disable the LUN/TPG, write the image, **preserve the unit serial** (`iscsi.2`), re-enable. Live-session 409 as the entry gate. `unmap` with no argument lists and force-cleans stale `map` devices — the sweep.)*

### iSCSI — block storage *(new)*

> As a user, I want to serve block storage over iSCSI from an ANAS node — a zvol or a raw image file exported as a LUN — so physical machines, VMs and other clusters get block devices with the same snapshot, clone and PBS-backup story my file shares have. **PVE only consumes iSCSI (`iscsi`, `iscsidirect`, ZFS-over-iSCSI storage types); it never serves it. TrueNAS does.**
>
> **Boundary (ruled 2026-08-25):** ANAS is the **target side only** — a generic, standards-compliant iSCSI target. PVE (host `iscsi:` storage) and guests (an in-VM initiator) are ordinary initiators; ANAS never provisions for them, never writes `storage.cfg`, never shows a `pvesm` snippet. DESIGN §5a stands (you cannot share a zvol by path); only its "out of scope" parenthetical is superseded by this epic.
>
> **Engine:** LIO, the kernel target (`target_core_mod`, `iscsi_target_mod`, `target_core_iblock`, `target_core_file` are in the pve kernel) driven by `targetcli-fb` (+ `python3-rtslib-fb`, in the trixie repo, installed like samba/nfs). Persisted config = `/etc/rtslib-fb-target/saveconfig.json` (structured, restored at boot by `rtslib-fb-targetctl.service`); live state = configfs. Read model from JSON + configfs, writes via `targetcli` — **one command per invocation** (real exit codes; stdin batching always exits 0 and auto-saves a half-applied state) — then `saveconfig`; LIO itself keeps 10 rotating gzipped copies of `saveconfig.json`, which satisfies the config-backup ruling without a second rotator. CHAP secrets never ride argv: they are written straight to configfs (argv-free, round-trips through `saveconfig`). No new code where LIO already does the work. Ground truth: `docs/ISCSI-GROUND-TRUTH.md`.
>
> **Backing kinds (final):** **zvol** (ZFS only; the ZFS default) and **raw image file via `fileio`** (both backends; **AHR's only kind** — a file on the btrfs volume IS the AHR block object, parallel to a zvol on ZFS). LV-backed LUNs rejected (outside AHR's btrfs data model); qcow2 rejected (unique but low value).
>
> **Threat model:** reduce exposure by default — portal bound to a chosen address, explicit initiator ACLs, CHAP offered (mutual too), LIO's demo mode (`generate_node_acls=1`) never.

##### Dev (ground truth first)
**iscsi.1** `[done 2026-08-25]` As a dev, I want ground truth on the stunt node with `targetcli-fb` installed and real initiators (the node's own `open-iscsi`, a PVE `iscsi:` storage; no Windows VM available — open item). **Result: `docs/ISCSI-GROUND-TRUTH.md` (48 facts) + 32 real fixtures under `fixtures/iscsi/` (targetcli-fb 2.1.53, rtslib 2.1.76; a real reboot was part of the proof).** Headlines: `wwn` is a **create-only** parameter and the unit serial is what initiators (and **PVE volids**) pin — recreate without it = a different disk, with it = byte-identical identity, but **attributes do not carry across a recreate** (replay contract = `{serial, attributes}`); **fileio size is fixed at creation** (delete + recreate with `wwn=`); zvol grow is live; boot restore with a missing backing device **reports systemd success** while the LUN silently vanishes (a whole missing pool ⇒ target up with zero LUNs); the unit has no ZFS ordering (anchor = `zfs-volumes.target`); target create auto-adds a `0.0.0.0:3260` portal (`auto_add_default_portal`); shipped defaults are `emulate_tpu/tpws=0`, **fileio write-back ON**, discovery open (`demo_mode_discovery=1`), no CHAP secret-length validation; sessions live in `acls/<iqn>/info` (not `dynamic_sessions`); ZFS already refuses destroy/export of a claimed zvol but **rollback, rename, volsize shrink and `rm` of a backing file succeed silently**; `fuser`/`lsof`/holders see nothing — the claim is only in configfs; the backstore name is the SCSI model string (VPD 0x83); LIO binds and keeps a portal on a non-existent address with no error; `/v1/disks` reports a zvol and even a self-served LUN as `available`; the zvol's `zd*` name moved across the reboot — only `/dev/zvol/<pool>/<vol>` is stable.

**iscsi.2** `[open]` As a dev, I want the shared schemas and the read layer: `IscsiTarget` / `IscsiPortal` / `IscsiLun` (kind, backing, size, **serial**, attributes, mapped initiators) / `IscsiInitiator` / sessions, parsed from `saveconfig.json` + configfs (sessions from `acls/<iqn>/info`; `vpd_unit_serial` carries a `T10 VPD Unit Serial Number: ` prefix; IPv6 portal addresses are stored bracketed; `alias` fields are random per create and never identity); **ownership derived without shadow state** (backing path on an ANAS-managed pool/dataset + naming convention ⇒ ANAS; anything else ⇒ tagged hands-off, the 3.25 pattern; **PVE's `vm-NNN-disk-M` zvols are never candidates**); and `GET /v1/iscsi/*` (resource table added to DESIGN.md when this lands). **Serial persistence is designed in here:** every path that (re)creates a backstore — boot restore, fileio resize, image restore — replays **both the stored serial (`wwn=`, create-only) and the attributes**, because initiators, ESXi, Windows and **PVE's own volids** identify a LUN by the serial and attributes are dropped on recreate. Backstores reference `/dev/zvol/<pool>/<vol>`, never `/dev/zd*`.

##### Volumes
**iscsi.3** `[open]` As a user, I want **ZFS volumes first-class in Datasets**: listed with size / `volblocksize` / used, create (size, `volblocksize`, sparse), grow (live under a LUN — the initiator rescans), snapshot/destroy through the existing verbs, "Share this" disabled (no path), PVE-owned zvols tagged hands-off — so the ZFS block object is manageable where the rest of the dataset tree is. *(Image files are created by the iSCSI screen on a chosen dataset or AHR pool, not here. **Rename, volsize shrink and rollback of a volume under a LUN are gated by `iscsi.6`** — ZFS lets all three through silently. The Datasets dialog-contract harness must cover the volume type.)*

##### The iSCSI menu
**iscsi.4** `[open]` As a user, I want an **iSCSI** menu: targets (IQN, portals, LUN count, sessions, enabled) with per-target LUNs (kind, backing, size, serial, mapped initiators, connected-now) and initiator ACLs; **create target** (stable ANAS-generated IQN, editable once, immutable after — a "rename" is a new target; portal address picked from PVE's network config, IPv6 ULA allowed, link-local refused by LIO; explicit ACLs; CHAP optional, mutual optional, secrets write-only); **add LUN** (pick an existing zvol, or create a sparse raw image file of a given size on a dataset / AHR pool); enable/disable; delete — every mutation a job. *(GT-driven contract: **the auto-added `0.0.0.0:3260` portal is removed/prevented on create** (`auto_add_default_portal`) — it violates the threat model and its presence is conditional, so verify rather than assume; **discovery closed** (`demo_mode_discovery=0`) alongside `generate_node_acls=0`; CHAP lives on the ACL under explicit ACLs and secrets are written to configfs, never argv; **secret length 12–16 bytes enforced in the schema** (LIO accepts 1 char); attribute defaults ANAS sets on every backstore — `emulate_tpu=1`, `emulate_tpws=1`, `max_unmap_lba_count` raised, **fileio `write_back=0`** (LIO ships it ON — data loss on crash) with write-back behind a warning, `block_size` chosen before the LUN is mapped (immutable after); **the backstore name is the SCSI model string initiators see** — it is the user-facing LUN name, validated, not an encoded pool/vol path. `targetcli` is not transactional: one command per invocation, LIO mutations serialized behind a daemon mutex, each change a journald audit line; LIO's own 10 rotating `saveconfig` copies are the backup — ANAS adds no second rotator. **`pvesm`'s `iscsi:` plugin has no CHAP field** — the dialog says so when PVE is the intended initiator (ACL-only).)*

##### Boot, lifecycle, gates
**iscsi.5** `[open]` As a user, I want targets to **survive reboot correctly**: `rtslib-fb-targetctl` ordered **after `zfs-volumes.target`** (and AHR activation) with the reverse at shutdown (target down before pools export); and — because **a restore with a missing backing device reports systemd SUCCESS while the LUN silently vanishes** (a whole missing pool ⇒ the target comes up enabled with zero LUNs; no `Restart=`/`OnFailure=` can catch it) — ANAS **diffs `saveconfig.json` against configfs** at boot and on demand, surfacing every hole as a dashboard warning (new `iscsi` category), and **never runs `saveconfig` over a degraded restore** (it would persist the hole). *(GT: the 1.2 s ordering margin observed on the stunt reboot was coincidence, not a dependency. Modules: rtslib loads every backstore plugin at once — there is no "load on first use".)*

**iscsi.6** `[open]` As a user, I want the rest of ANAS to **know a LUN is there**: ZFS already refuses `destroy`/`export` of a claimed zvol (`dataset is busy`) — ANAS turns that into "held by LUN <target>/<n>" (**`busy-diagnosis.ts` gains an LIO branch reading configfs `CLAIMED`/`udev_path` — `fuser`, `lsof` and `holders/` see nothing**); the operations ZFS lets through silently — **rollback, rename, volsize shrink, and removing a backing image file** — are refused under a LUN (rollback under a live session outright); deleting/resizing a LUN with a live session is a 409; **portal addresses are checked against live interfaces by ANAS** (LIO binds and keeps a portal on a non-existent address with no error, ever); a PVE firewall that would block 3260 is warned about, never edited; **the disk inventory excludes `zd*`** (loop devices already are) and tags an iSCSI-transport disk whose serial matches one of this node's own LUNs as hands-off (seam: the one filter in `parsers/lsblk.ts`).

##### Live-proof
**iscsi.7** `[open]` As a dev, I want the whole arc live-proven on the stunt node through the real API: create target + zvol LUN + file LUN → connect from `open-iscsi` and from a PVE `iscsi:` storage (volid carries the serial) → ACL rejection of an unlisted initiator → CHAP (one-way + mutual) → write data → reboot the node, data, serial and attributes intact → grow both kinds with the serial preserved (fileio = recreate path) → refusals (rollback/rename/shrink under LUN, delete with a session, missing-device boot hole surfaced) → back up both LUNs to the disposable PBS (`backup2.4`) and restore one (`backup2.7`) → delete target, journald audit present — before any release gate. *(Open item: a Windows initiator for the serial/CHAP quirks — no VM available on the stunt node.)*

---

## 4. Candidates (serious; not authorized)

One paragraph each. Promotion to §3 is an operator call.

- **Local-snapshot file restore** *(decoupled from Backup phase 2, 2026-08-25)*: the `backup2.5` picker over `.zfs/snapshot/<s>/` and AHR ro snapshots, copying selected files back without a rollback. No backup client involved — "just files". Its own small epic when wanted.
- **Ceph RGW / S3**: surface the object gateway PVE installs but never exposes — ANAS's purest "thing PVE doesn't do". Candidate epic.
- **Lean HA / event-driven replication**: near-term, replication triggered off the ZFS `written` counter (idle disks stay asleep); later, a 2-node quasi-HA without Ceph (SMB msdfs, NFS keepalived VIP) — async, bounded RPO, never sold as true HA.
- **Policy-based tiering (3.24)**: scheduled, auditable data movement between fast and capacity tiers inside a pool. Own epic; the vdev/composer work is its prerequisite.
- **Dataset encryption (4.11)**: key management (passphrase/keyfile, load/unload, change-key). Deferred until a user asks.
- **Backup-source guard**: a backup pre-flight that refuses archive paths on configured-but-unmounted mounts (facts already in the inventory; the pictures-mount boot-race incident).
- **Zero-gain expand guard**: an AHR expansion plan with no capacity gain should refuse or demand acknowledgment instead of a 275 ms "success". *(Unfiled; never ruled.)*
- **Enclosure / physical-path topology** in the disk picker and topology view (by-path USB bus), so fault-domain spread is visible at compose time.
- **Directory services (Epic 14) (AD/LDAP via realmd/winbind/sssd) + NFSv4 ACLs (4.7.1)**: enterprise; deferred until demand. The `getent` seam keeps it a drop-in.
- **Shelved, demand-gated (don't re-raise unprompted):** Time Machine target (vfs_fruit + size cap, no avahi); SMB Previous Versions + recycle bin (vfs_shadow_copy2/vfs_recycle); scrub history page; Disks-tab pool→band hierarchy (needs a tree panel); `.deb` packaging + apt repo; data mover (mc-shaped dual-pane, moves-as-jobs).
- **Napkin only (not roadmap):** AHR userspace self-heal via btrfs checksums; "Boost" sync priority + the OS-tuning boundary rule; AHR in-place rebalance (riskiest op we could ship — honest paths stay create-time-mix or grow-with-≥largest).

---

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
| PVE "ZFS over iSCSI backend" wizard / `pvesm` snippets | ANAS is the target side only; PVE is an ordinary initiator | iscsi (2026-08-25) |
| Content types / `storage.cfg` writes | PVE territory is read-only, always | 18 |
| UI auto-refresh after upgrade (#31) | PVE parity: PVE's own UI needs a hard reload too; skew banner + notes advisory suffice | #31 |
| TODO-list / dev-process issues on GitHub (#45) | Public issues are for real bugs; follow-ups tracked locally | #45 |
