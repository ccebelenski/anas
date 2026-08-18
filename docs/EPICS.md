# ANAS — Epics & Stories

Stories follow the format: **As a [role], I want to [action], so that [outcome].**

Roles:
- **user** — any authenticated user. If you're logged in, you can see and do everything. Auth is binary: logged in or not.
- **dev** — developer/engineering role. Dev stories are non-deliverable prerequisites: infrastructure, scaffolding, parsers, test harnesses. They exist to make the scope of foundational work visible.
- **component** — a UI component or API endpoint that consumes data from another part of the system. Component-as-actor stories make dependency graphs explicit: the dashboard *consumes* what the pool status component *provides*.

Story numbering is for identification only, not implementation order. Within each epic, stories are ordered by natural workflow: observe → understand → act.

---

## Epic 0: Foundation & Infrastructure

> Dev infrastructure that multiple epics depend on. No direct user-facing deliverable.

### Stories

0.1. [done] As a dev, I want the Nuxt 3 project initialized with TypeScript, PrimeVue, and Pinia, so that I have a working frontend skeleton.

0.2. [done] As a dev, I want anasd initialized as a Fastify server listening on a Unix domain socket, so that I have a working daemon skeleton.

0.3. [done] As a dev, I want a shared schema package (Zod) importable by both anas and anasd, so that types and validation are defined once.

0.4. [done] As a dev, I want a REST client in Nuxt that communicates with anasd over the Unix socket (with auth header propagation), so that API routes can delegate to the daemon.

0.5. [done] As a dev, I want the job queue implemented in anasd (submit, status polling, lifecycle management), so that all mutations have infrastructure to run on.

0.6. [done] As a dev, I want a command executor abstraction with Prod and Mock implementations, so that development and testing don't require a real Proxmox/ZFS system.

0.7. [done] As a dev, I want the auth provider interface defined with PVE, PAM, and Dev implementations, so that authentication is pluggable from day one.

0.7.1. [done] As a dev, I want auth simplified to PVE-only (with Dev for testing), removing PAM, JWT, and login page — since ANAS is always accessed through Proxmox, Proxmox owns the session.

0.8. [done] As a dev, I want audit logging to journald wired into anasd, so that every mutation is traceable from the start.

0.9. [done] As a dev, I want a basic app layout shell (sidebar nav, header, content area), so that feature work has a place to live.

0.10. [done] As a dev, I want a CI pipeline (lint, type-check, test), so that quality is enforced from the start.

---

## Epic 0.5: Test Infrastructure — Stunt PVE Node & Integration Tests

> Dev infrastructure for end-to-end testing against a real Proxmox/ZFS stack. A local PVE VM serves as the test target; Playwright drives the browser UI. Integration tests are a manual PR gate — not CI.

### Stories

#### Host Setup
0.5.0. [done] As a dev, I want a setup script that installs host prerequisites (qemu-kvm, libvirt, anas-test network) and generates config.local, so that the stunt node environment is reproducible.

#### VM Setup
0.5.1. [done] As a dev, I want a script that creates a Proxmox VE VM (Debian 13 cloud image + cloud-init) on the local machine using libvirt/QEMU, so that I have a real PVE environment for testing.

0.5.2. [done] As a dev, I want the stunt VM provisioned with PVE 9, ZFS, Samba, NFS, and Node.js 22, so that the full ANAS feature set can be tested.

0.5.3. [done] As a dev, I want VM lifecycle scripts (start, stop, snapshot, restore, add-disk, remove-disk, destroy), so that I can reset to a clean baseline between test runs and test hot-plug scenarios.

#### ANAS Deployment
0.5.4. [done] As a dev, I want a script that deploys ANAS to the stunt VM (build, rsync, systemd units, start services), so that I can test against the real stack without manual steps.

#### Integration Testing
0.5.5. [done] As a dev, I want Playwright installed and configured to drive the ANAS UI via the stunt VM, so that I can run end-to-end browser tests.

0.5.6. [done] As a dev, I want a test harness that authenticates through Proxmox (real PVEAuthCookie + RSA-SHA1 verification), navigates to ANAS, and verifies the dashboard loads, so that the full auth chain is tested.

0.5.7. As a dev, I want integration test helpers that create/verify/destroy ZFS pools and datasets on the stunt VM, so that storage operations can be tested end-to-end. *(Activates with Epic 3.)*

0.5.8. As a dev, I want integration test helpers that create/verify/destroy SMB and NFS shares on the stunt VM, so that share management can be tested end-to-end. *(Activates with Epics 6–7.)*

#### CI Strategy
*Integration tests are a manual gate — the PR reviewer runs them on their stunt node before approving. CI (GitHub Actions) stays lint/typecheck/build only.*

---

## Epic 1: Authentication & Session Management

> [done] Proxmox owns auth. ANAS verifies PVEAuthCookie locally via RSA-SHA1.

### Stories

1.1. As a user, I want to access ANAS from the Proxmox UI sidebar and be automatically authenticated via my Proxmox session, so that it feels like part of Proxmox with no separate login. *(Realized by Epic 13 — PVE UI embedding with ticket handoff; packaged by 10.3.)*

1.2. [OBE] ~~As a user, I want a fallback login page with PAM authentication, so that I can access ANAS directly (not through Proxmox) if needed.~~ *ANAS is always accessed through Proxmox; PVE owns auth.*

1.3. [OBE] ~~As a user, I want ANAS to auto-detect whether Proxmox is available at startup and choose the right auth provider, so that I don't have to configure authentication manually.~~ *Simplified: PVE in production, Dev for testing. No auto-detection needed.*

1.4. [OBE] ~~As a user, I want my session to expire after inactivity, so that an unattended browser isn't a security risk.~~ *Proxmox manages session expiry via PVEAuthCookie.*

1.5. [OBE] ~~As a user, I want to log out explicitly, so that I can secure my session when I'm done.~~ *Logout is through Proxmox UI.*

#### Dev
1.6. [OBE] ~~As a dev, I want a mock PVE auth endpoint in the test suite, so that I can test PVEAuthCookie validation without a real Proxmox instance.~~ *Dev auth provider bypasses PVE entirely.*

1.7. [done] As a dev, I want scripts to start, stop, and build the full stack locally (`npm run dev`), with clear documentation of the development workflow, so that onboarding is frictionless.

---

## Epic 3: ZFS Pool Management

> As a user, I can create, manage, and monitor ZFS storage pools.

### Stories

#### Dev (build first — parsers and data layer)
3.15. [done] As a dev, I want ZFS output parsers for JSON (`-j`) format (PVE 9+ / ZFS 2.4+), so that pool/vdev/disk data is consistently structured for the API layer.

3.16. [done] As a dev, I want real ZFS command output fixtures captured from the stunt node (healthy, degraded, mid-scrub, mid-resilver, suspended), so that I can develop and test the UI against realistic data.

#### Observe
3.1. [done] As a user, I want to see all available disks and their current usage (unpartitioned, part of a pool, etc.), so that I understand what hardware I have.

3.2. [done] As a user, I want to see the status of each pool (online, degraded, faulted, scrub progress), so that I can monitor health.

3.3. [done] As a user, I want to see the vdev topology of a pool (which disks are in which vdevs, spares, cache, log), so that I understand the physical layout.

3.4. [done] As a user, I want to see pool properties (ashift, autoexpand, etc.), so that I understand current configuration.

3.5. [done] As a user, I want to see scrub progress and history, so that I know when the last integrity check ran and how it went. *(Future: parse `zpool status -v` for per-file error details.)*

3.6. [done] As a user, I want to see SMART health data for individual disks, so that I can identify drives that may be failing.

#### Disk health (ZFS-focused — not a PVE inventory clone)
> The generic disk inventory + wipe/GPT/LVM is PVE's job (Principle 15). ANAS's disk view is about disks *as ZFS storage*: health-in-context and the replace workflow. Decided July 2026 — do both a pool-topology integration and a standalone triage view.

3.17. [done] As a dev, I want disk data enriched with ZFS topology context (vdev name/role, per-disk read/write/checksum error counts) and a derived health status (healthy/warning/critical/unknown, fusing SMART pass-fail with ZFS errors), so both disk surfaces share one health model. *(Cheap signals only — no smartctl-per-disk on list calls.)*

3.18. [done] As a user, I want a Disk Health view that shows every disk's ZFS health at a glance (pool/vdev/role, ZFS error counts, SMART, at-risk disks surfaced first) with disk-first actions (Replace, Add as spare/cache/log), so I can triage failing disks across all pools without hunting through each pool. *(Replaces the inventory-clone Disks view.)*

3.19. [done] As a user, I want per-disk health and a Replace action inline in the pool topology, so I can act on a failing disk in the context where I see it.

3.20. [done] As a user, I want the Disk Health view grouped by pool → vdev (with unassigned/available disks in their own group), so that many disks stay scannable instead of a flat horde. *(Cheap — ExtJS grid grouping on a computed key. A graphical disk→vdev→pool connection diagram is a possible later, heavier follow-on.)*

#### Act
3.21. [done 2026-07-15] As a user, I want to add **Log (SLOG) / Cache (L2ARC) / hot Spare** vdevs — at pool creation and to an existing pool — so I can tune ZFS performance and resilience (PVE's pool UI offers none of this). *Scope:*
- *Create: the API is DONE (CreatePoolRequest.logVdevs/cacheDisks/spareDisks, buildCreateArgs). Gap is UI only — best delivered via the vdev-centric composer (3.23) rather than bolting pickers onto the current single-vdev create window.*
- *Add-to-existing: gap is schema + daemon + UI — give AddVdevRequest a role/class (log/cache/spare), branch the daemon add to `zpool add <pool> log|cache|spare <spec>`, expose it in the composer (3.23).*

3.23. [done — create-side, 2026-07-14] As a user, I want a **vdev-centric pool composer** (TrueNAS pool-manager style) for creating and expanding pools — stage vdevs one at a time (pick role: data/log/cache/spare/special + type + disks), see the pool topology build up, add/remove before committing — so I can build a multi-vdev pool in one workflow instead of creating a bare pool then adding vdevs one-by-one. *Key: the API is ALREADY vdev-centric (CreatePoolRequest composes dataVdevs[]/logVdevs[]/cacheDisks[]/spareDisks[]; POST /pools takes the whole topology at once) — this is a UI/UX story. The same composer serves create AND edit/expand (drives POST /pools for new, add-vdev for existing), and is the natural home for redundancy-consistency warnings (don't mix raidz+mirror data vdevs; enforce special/log redundancy per 3.22). Supersedes the "simple create window" and folds in the UI half of 3.21.*
>
> **Design notes (from the spike review, 2026-07-14):**
> - **Rendering**: SVG objects (disk/SSD/NVMe icons, vdev "bays") on themed ExtJS chrome — NOT canvas (canvas has no DOM nodes → no `anas-*` test hooks, no CSS theming). Drag is tractable with hand-rolled Pointer Events (~40 lines, validated in the local spike); a small vendored lib (Interact.js, UMD in the concat) is optional polish for touch/snapping, not load-bearing. Build it as a reusable **`ANAS.gfx`** layer (icons + node/drag toolkit) shared with the Dashboard. Skeuomorphic-but-restrained: objects carry their own material gradients, chrome themes around them.
> - **Commit gating**: the "Create pool" button MUST be disabled while the draft is invalid (a vdev below its min disks, an unprotected special/log vdev, no data vdev, etc.) — don't let an invalid topology be submittable.
> - **Pool advisor (differentiator)**: an analysis panel under the summary that (a) characterizes how the pool is best used from its composition (e.g. "Capacity pool (all-HDD) — best for sequential access / large files"), (b) suggests improvements from the *available* unused disks (e.g. "you have 2 spare SSDs → a mirrored **special** vdev would accelerate metadata & small files"), and (c) states honest **caveats** — a Cache/L2ARC vdev helps only when the working set exceeds ARC (RAM) yet fits L2ARC, and costs RAM for headers; a SLOG helps only *sync* writes (NFS/DBs), useless for async; a special vdev's loss loses the pool. Rules-based, advisory, not salesy — this is the "guide the user, don't just warn them" thesis, which is exactly where TrueNAS's UX is weak.

3.22. [done 2026-07-15] As a user, I want **special** and **dedup** allocation-class vdevs, so metadata and small blocks live on fast devices. *(Deferred behind 3.21 — riskier. SAFETY: a special/dedup vdev holds pool-wide metadata; its loss loses the WHOLE pool, so the UI must ENFORCE redundancy — ideally matching pool redundancy — not merely warn. Scope note: also expose `special_small_blocks` (route small data blocks, not just metadata, onto the fast tier). Industry-confirmed: TrueNAS's July 2026 "hybrid storage is hot again" post cites special vdevs requiring mirror redundancy today, with RAIDZ special support arriving — so plan for both mirror and raidz special vdevs.)*

3.24. [backlog — likely its own epic] As a user, I want **policy-based tiering** — scheduled, auditable movement of data between fast and capacity tiers within a single pool (not a black-box heat-map). *(NEW idea, from TrueNAS's July 2026 hybrid-storage post; their TrueNAS 26 feature. Heavier than vdev management — it's live data mobility with checksum preservation, schedules, and policies — so it likely warrants its own epic rather than a pool-management story. The hybrid-vdev work (3.21/3.22) + the composer (3.23) are the prerequisites: you can't tier without the tiers.)*

3.25. [done 2026-07-15] As a user, I want ANAS to **recognize pools PVE already manages** (VM/LXC disks, backups) and treat them as PVE's territory — distinctly tagged and hands-off — so I don't accidentally reach for the wrong pool or break running guests. *Identification is READ-ONLY and authoritative: parse `/etc/pve/storage.cfg`, whose `zfspool` entries name the pool (content `images,rootdir`); a `dir` storage on a ZFS mountpoint is a secondary (backup/iso) signal, deferred. This never writes PVE config, so it stays within the guest philosophy. Surfaced as a new `pveStorages[]` field on PoolSummary/PoolDetail (empty ⇒ ANAS-managed). Behavior: **Pools** — "PVE" badge; only Scrub/Trim/Upgrade/Detail enabled (Export/Destroy/Add-vdev/Attach/Modify disabled). **Datasets** — pool + its datasets tagged PVE, view-only; child-dataset creation blocked via a SOFT, explained gate (a homelab "add an ANAS data dataset here" opt-in is a future flip, safe because PVE owns datasets, not the pool). **Shares** — no special rule needed (nothing shareable under hands-off). Ownership is per-dataset, so hybrid storage is deliberately not encouraged, not permanently foreclosed.*

3.26. [done 2026-07-15] As a user, I want the **pool root dataset to be first-class** in ANAS — snapshots, share, and editable properties — so a NAS pool's root is fully manageable, not just a container. *Scoped to ANAS-managed pools only; on PVE-managed pools the root stays view-only (a recursive root snapshot there would sweep PVE's guest zvols into snapshots PVE doesn't track — a real collision, not just tidiness). Closes the gap the pool-root previously had (props were partly wired; snapshots/share were not).*

3.28. [done 2026-07-24] As a user creating a ZFS pool, I want **no default pool name** — empty field, `name` placeholder, commit gated until valid — matching the AHR composer's no-default-names rule. *(Operator parallel-construction revision 2026-07-24; the composer previously pre-filled `tank`.)*

3.27. [done 2026-07-24] As a user creating or managing a ZFS pool, I want the **mountpoint treatment AHR pools already have, retconned into ZFS**: an optional mountpoint override at create (composer field with the live default placeholder — ZFS default `/<pool>`), a Mount column on the pool grid, and a confirm-gated **Change mount** action in pool details — so both pool kinds function identically. *(Operator design revision 2026-07-24 — parallel construction, reverse direction. Mechanics differ honestly: ZFS mountpoints are a zfs-native property (`zpool create -m` / `zfs set mountpoint=`), NOT fstab — no fstab writes; the same collision checks apply (live mounts, fstab claims, `/mnt/pve` reserved), and the change action states that child dataset mountpoints inherit/move with the pool root. ANAS-managed pools only; PVE-managed pools stay hands-off per 3.25.)*

3.29. [done 2026-07-24] As a user whose unmount fails because something is holding the filesystem, I want the error to **name the culprit process(es)** — `… — held open by: chia_harvester(1234), smbd(567)` — so I know WHY it's busy without being told to run `fuser` by hand. *(Operator contract from a real pve5 failure: `zpool destroy` gave only `cannot unmount '/chiapools/pool15': pool or dataset is busy` — root cause was a chia harvester holding plot-dir FDs. "Guide, don't just warn." This is the **guide-the-user** thesis applied to errors: the primary failure is surfaced unchanged, with the holders appended. **Spans ZFS/AHR/mounts** — one shared daemon helper (`services/busy-diagnosis.ts`) wired into every busy-prone unmount: ZFS pool destroy + dataset destroy, the ZFS + AHR mountpoint moves, AHR destroy, AHR snapshot rollback's brief unmount + on-demand top-level mount, and the Mounts unmount/remove. Tool: `fuser` (psmisc — ships in the Debian/PVE base; `lsof` needs installing) via terse `fuser -m <path>` + `/proc/<pid>/comm`, ground-truthed on the stunt node. Strictly additive and fail-open: tool missing / no holders / not a busy error / no known path ⇒ the original error is surfaced verbatim, never masked. Path is passed by the caller or extracted from the error text (`umount: <path>:` / ZFS `'<path>'`). Capped at 5 holders with `+N more`. Flows through the existing job-error / route-error surfaces — no new UI.)*

3.30. [done 2026-07-27] As a user building a ZFS pool, I want mismatched-disk **capacity waste surfaced and gated**, so the composer never green-lights a layout that silently throws away capacity. The ZFS create composer gains AHR-create's treatment: an **Unprotected (wasted)** capacity line (per-data-vdev `Σ(member − smallest)`, mirror+raidz; stripe = 0), a warning on **any** waste > 0 (with an 'AHR would reclaim it' hint), and the uniform amber commit-gate. *(Operator 2026-07-27, from a real screenshot: a mirror of an 8 TiB + 20 TiB disk showed '✓ Ready to create' while wasting ~12.7 TiB. Advisory gate, not the 409 danger path — waste ≠ data loss.)*

3.31. [done] As a user expanding a ZFS pool, I want **full pool expansion including RAIDZ expansion**, so a single disk dropped onto the pool composer does the honest thing for *where* it lands — **drop-location = intent**. Three outcomes off the ONE `zpool attach` verb: dropping onto a **mirror / single-disk** leaf → `zpool attach <pool> <leaf> <new>` (+redundancy, resilver — ungated by ZFS version, the old 3.12 behavior); dropping onto a **RAIDZ vdev** → RAIDZ EXPANSION `zpool attach <pool> <raidz-vdev-name> <new>` (+capacity, reflow — the SAME verb aimed at the vdev NAME, e.g. `raidz1-0`); add-vdev (`zpool add`, 3.11) is unchanged. **ONE disk per attach** (OpenZFS has no atomic multi-disk widen). **Gates (daemon):** ① raidz-expand refused unless the node's OpenZFS module is **≥ 2.3.0** AND the pool's `feature@raidz_expansion` is enabled/active — a GUIDING 409 (offers `zpool upgrade <pool>` for the flag, states the version for the module); mirror-attach and replace are NOT version-gated. ② **Busy gate** on mirror-attach AND raidz-expand: a hard 409 refusal (mirrors the AHR 11.6 degraded-refusal altitude, no confirm bypass) while a resilver or raidz reflow is in progress, surfacing the in-progress op + percent + "try again when it finishes"; a scrub is a soft note, not a block. ③ existing wipe/confirm safety unchanged. **Honest capacity (raidz):** expansion does not re-lay-out existing data — old blocks keep their pre-expansion parity ratio until rewritten, so realized usable gain is LESS than a naive "+1 disk"; the API exposes both the naive column size and the honest realized gain (an ESTIMATE) plus advisories (rewrite/send-recv realizes the full ratio; wide-raidz1 widening keeps single-disk parity over a wider stripe). **autoexpand (3.31a):** ANAS-created pools now default `-o autoexpand=on` at create (overridable), and a `zpool replace` with a larger disk runs `zpool online -e <pool> <device>` after so grown capacity is realized even on autoexpand=off pools (guest philosophy — we online the device we replaced, never flip a pool's autoexpand). *Stage-1 daemon: `AttachDiskRequest.targetVdev` + dispatch, `GET /v1/pools/:name/expansion` (per-vdev eligibility/verdict + honest capacity read model), local `zfs version` detector (≥ 2.3.0 boundary), `feature@raidz_expansion` reader, resilver/reflow busy-state parser. Stage-2 UI: the composer drop-target treatment (which vdev accepts which drop, the honest capacity + advisory callouts, the guiding refusals). **Ground-truth caveat:** the raidz-reflow busy-state parser is based on the DOCUMENTED OpenZFS `pool_raidz_expand_stat_t` shape, NOT a live capture (a live reflow is hard to produce on demand) — live-verify on pve5; the parser is deliberately tolerant of field-name drift, and mirror-attach / resilver detection ARE fixture-backed. The honest raidz capacity math is likewise a documented estimate pending live calibration.*


3.7. [done] As a user, I want to import an existing pool (e.g., after moving disks from another system), so that I can access the data.

3.8. [done] As a user, I want to create a ZFS pool by selecting disks and a redundancy level (mirror, raidz, raidz2, etc.), so that I can set up storage appropriate for my needs.

3.9. [done] As a user, I want to modify pool properties, so that I can tune pool behavior.

3.10. [done] As a user, I want to start a scrub on a pool, so that I can verify data integrity.

3.11. [done] As a user, I want to add a vdev to an existing pool, so that I can expand capacity.

3.12. [done] As a user, I want to attach a disk to a mirror (or replace a failed disk), so that I can restore redundancy.

3.13. [done] As a user, I want to export a pool, so that I can safely move it to another system.

3.14. [done] As a user, I want to destroy a pool, so that I can reclaim the disks. *(Confirmation required, clearly dangerous.)*

---

## Epic 4: ZFS Dataset Management

> As a user, I can create and manage datasets within pools to organize storage.

### Stories

#### Observe
4.1. [done] As a user, I want to see all datasets in a tree hierarchy, so that I understand how storage is organized.

4.2. [done] As a user, I want to see dataset space usage (used, available, referenced, quota), so that I can monitor consumption.

4.3. [done] As a user, I want to see dataset properties (compression, record size, mountpoint, etc.), so that I understand current configuration.

4.4. [done] As a user, I want to see which shares (SMB and NFS) are associated with a dataset, so that I understand how it's being used before making changes.

#### Act
4.5. [done] As a user, I want to create a dataset with configurable properties (compression, quota, reservation, record size), so that I can organize storage by purpose.

4.6. [done] As a user, I want to modify dataset properties, so that I can adjust behavior as needs change.

4.7. [done] As a user, I want to set basic POSIX permissions (owner, group, mode via chown/chmod) on a dataset's mountpoint, so that the right users can access it. *(MVP scope: POSIX only, owner/group limited to EXISTING system users. This is the shallow part.)*

4.7.2. [done 2026-07-14] As a user, I want a layered filesystem-permissions editor on a dataset — Owner / Group / Everyone with plain-language access levels (No-access / Read / Read-Write), plus "+ add user or group" for extra principals, an "apply to existing files" (recursive) option, and an Advanced door to raw ACL entries — so I can manage access without deciphering octal or ACE flags. **Backed by POSIX ACLs** (`getfacl`/`setfacl`, `acltype=posixacl`): base rows → mode bits, extra principals → named ACL entries, inheritance → default ACL + setgid (grants inherit by default). *(Decided 2026-07-14 — this is the "better-UX-than-TrueNAS" story. Consumes Epic 8 identities. Spike confirmed on the stunt node: needs the `acl` package + acltype=posixacl; base rows work with neither.)*

4.7.1. [deferred — Epic 14] As a user, I want NFSv4 ACLs (per-ACE who × granular permission-bits × inheritance flags, DENY entries, `acltype=nfsv4`), so I can manage **Windows-file-server-parity** permissions from Explorer's Security tab. *(Deliberately deferred: NFSv4 ACLs earn their complexity only for the Windows-managed/AD-joined shop — and are themselves the source of TrueNAS's permission confusion. Same layered UI as 4.7.2; only the ACL backend changes. Verify the OpenZFS-on-Linux nfs4 tooling before committing. Pairs with Epic 14.)*

4.8. [done] As a user, I want to destroy a dataset, so that I can clean up unused storage. *(Confirmation required, warn if dataset has children or active shares.)*

---

## Epic 5: ZFS Snapshots

> As a user, I can create and manage snapshots for point-in-time data recovery.

### Stories

#### Observe
5.1. [done] As a user, I want to see all snapshots for a dataset, so that I know what recovery points exist.

5.2. [done] As a user, I want to see how much space each snapshot is consuming, so that I can manage snapshot retention.

#### Act
5.3. [done] As a user, I want to create a snapshot of a dataset, so that I can capture the current state.

5.4. [done] As a user, I want to rename a snapshot, so that I can give it a meaningful name.

5.5. [done] As a user, I want to rollback a dataset to a snapshot, so that I can recover from mistakes. *(Confirmation required, clearly destructive.)*

5.6. [done] As a user, I want to destroy a snapshot, so that I can reclaim space.

5.7. [done] As a user, I want to clone a snapshot into a writable dataset (`zfs clone`), so I can branch off a point-in-time copy. *(Small once snapshots exist.)*

5.8. [done 2026-07-15] As a user, I want stronger visual separation between a dataset's snapshots and its child datasets in the tree, so nesting is unambiguous. *(MVP lists snapshots before child datasets; a divider/section header or grouping would be clearer.)*

---

## Epic 4.5 (backlog): Additional ZFS Dataset Capabilities

> Beyond the core properties already in Epic 4. Brainstormed July 2026.

4.9. [done] As a user, I want to see each dataset's achieved compression ratio (`compressratio`) and pick a modern compressor (lz4/zstd), so compression gives visible feedback. *(Cheap — fold into 4.3/4.5.)*

4.10. [done] As a user, I want to toggle deduplication on a dataset, behind an ADVANCED, heavily-warned control that shows the dedup table's RAM cost. *(Plumbing is trivial (`zfs set dedup=`); the responsibility is the guardrails — ~1–5 GB RAM/TB, sticky on existing data. OpenZFS 2.3 fast-dedup softens it.)*

4.11. [deferred 2026-07-18 — until user demand] As a user, I want native at-rest encryption on datasets (aes-256-gcm), so data is protected on disk. *(Set at creation. The work is KEY MANAGEMENT: passphrase vs keyfile, load/unload, change-key — not the property itself. Possibly its own epic. Deferral rationale: PVE's own UI manages no ZFS encryption anywhere — no encrypted ZFS-on-root install, no dataset encryption, no key handling (its only encryption toggles are Ceph OSD dmcrypt and PBS backups) — so there's no platform precedent to match; and per the guest philosophy, datasets encrypted outside ANAS coexist fine, ANAS just doesn't manage keys. Revisit when someone actually asks.)*

4.12. [done, scoped] As a user, I want small tuning/maintenance actions: manual `zpool trim`, `sync`/atime toggles (with a data-loss warning on sync=disabled), and pool feature-flag `upgrade`. *(Completeness; each tiny.)*

---

## Epic 5.5 (backlog): ZFS Replication (zfs send/recv)

> The highest-value missing ZFS capability — snapshots are useless off-box without it. Likely warrants promotion to a full epic (cf. TrueNAS "Replication Tasks"). Brainstormed July 2026.

5.5.1. [done 2026-07-16] As a user, I want to replicate a snapshot to another local pool (`zfs send | zfs recv`), so I have a backup on separate disks.

5.5.3. [done 2026-07-16] As a user, I want a dedicated **Replication** menu item — a task grid (source → target, last run, next run, **lag**), create/edit/disable/delete, and Run Now with real progress (stream size from `zfs send -nvP` dry-run) — so replication is configurable and observable in one place.

> **Design decisions (agreed 2026-07-16):**
> - **New top-level menu item** (sibling of Pools/Datasets/Shares); replication is an ongoing process with config + history, not a point-in-time view.
> - **Dashboard policy**: only RUNNING syncs (jobs strip) and FAILURES (warning card, new `replication` category; a task silently overdue past its interval counts as failed) appear. Healthy/idle shows nothing.
> - **Task store = the systemd units themselves** (`anas-repl-<name>.service` + `.timer`, generated/parsed/rewritten by ANAS; no second config source; no custom scheduler per the standing ruling). The service invokes a helper that POSTs the daemon's replicate job and polls to completion, exiting nonzero on failure so systemd's own last-result is truthful.
> - **journald is forensics, never correctness** (it rotates): authoritative last-success/lag derive from ZFS snapshot state on both ends (the newest common snapshot IS the durable record); current failure state from systemd unit/timer persistent state; journald supplies recent run detail only, labeled as such. (Future option if per-run detail must be durable: stamp a ZFS user property on the destination snapshot.)
> - **Safety**: destination `readonly=on` by default; `recv -F` (divergence rollback) behind the 409-confirm gate; UI must announce a FULL send (with size) whenever the incremental chain is broken; `zfs hold` on the incremental base so cleanup can't sever the chain.
> - **Sequencing**: local one-shot job → the view + timers → remote (5.5.2). Remote leverages PVE cluster SSH trust (free between cluster nodes); receiver needs ZFS only, NOT ANAS. *(Local target; incremental via `send -i`.)*

5.5.2. [done 2026-07-16 — stunt-node proven; real-node validation DEFERRED 2026-07-18 (operator call: staging a receiving end on real infrastructure is labor-intensive and low personal value; stunt-node proof suffices — if it worked locally it should work remotely)] As a user, I want to replicate to a remote host (`zfs send | ssh | zfs recv`), so I have off-site backups / migration.

> **Stage-3 design decisions (agreed 2026-07-16):**
> - **Remote needs sshd + ZFS only — no software installed there, ever.** All remote ops are `ssh <remote> zfs …` (list for base-discovery/lag, recv, hold). Push-only; progress comes from the local send side. TrueNAS works as a target out of the box.
> - **Two peer tiers.** Cluster peers: auto-discovered from `/etc/pve/.members`, zero-config (PVE cluster nodes already share root SSH trust). External remotes: explicitly registered.
> - **The corosync store (operator's idea).** Registry at `/etc/pve/anas/remotes.json` — pmxcfs replicates it cluster-wide (register a remote once, every node sees it). ONE cluster-wide keypair at `/etc/pve/priv/anas/replication_key` (pmxcfs enforces 0600 root-only): paste one public key on the remote and every node can replicate to it. Pinned host keys in `/etc/pve/priv/anas/known_hosts` (fingerprint confirmed once, trusted cluster-wide). Works identically on non-clustered nodes (pmxcfs runs standalone; verified). Caveats: writes are quorum-gated (no quorum → registry edits fail with a clear error; reads/scheduled runs unaffected); small files only.
> - **Split-brain/concurrency guard (operator requirement):** the registry carries a monotonic `version` + `updatedBy`/`updatedAt`; ALL writes are compare-and-swap (mutation carries the expected version; daemon 409s if it moved; UI refreshes and re-prompts) — the same optimistic-concurrency discipline as the shares config-writer. pmxcfs atomic file replace underneath.
> - **Hand-holding:** add-remote dialog generates/shows the public key with per-type paste instructions (incl. the TrueNAS UI path), shows the host-key fingerprint for explicit confirmation (no silent TOFU), and a Test-connection button that DIAGNOSES (unreachable vs auth vs no-zfs vs permission) rather than just failing.
> - **v1 scope:** external remotes connect as root (or the remote's admin); `zfs allow` delegation is a noted hardening follow-on, not faked. Remotes = cluster-level concept (corosync store); tasks stay per-node systemd units (bound to the node owning the source pool). *(The meat: remote target + auth, incremental streams, resume tokens.)*

> **Scheduling (affects 5.x replication, snapshot retention, scrub schedules): LEVERAGE existing tools, never build a scheduler.** A scheduler is undifferentiated code (user's rule) and violates Principle 7. ANAS surgically configures `sanoid`/`zfs-auto-snapshot`/systemd-timers/`pve-zsync` and presents a UI over them — it does not run its own scheduler.

---

## Epic 6: SMB Share Management

> As a user, I can create and manage SMB (Windows/Samba) file shares.

> **Status: shipped 2026-07-13.** 6.1–6.10 all done — round-trip smb.conf parser + fixtures, `/v1/shares/smb*` routes (list-all incl. admin shares, smbstatus connections, global config, create/modify/remove via surgical `editConfig`, `systemctl reload smbd` side effect), and the unified Shares UI. Verified live on the stunt node: create → surgical stanza append, confirmed delete → clean removal, `/etc/samba/smb.conf` byte-identical to pre-state (154 comments preserved).

### Stories

#### Dev (build first — parser)
6.9. As a dev, I want a round-trip smb.conf parser (parse → modify → write) that preserves comments, whitespace, ordering, and unknown directives, so that surgical config editing works correctly.

6.10. As a dev, I want smb.conf test fixtures (minimal, complex, hand-edited with comments, Proxmox-default), so that the parser is tested against real-world configs.

#### Observe
6.1. As a user, I want to see all configured SMB shares (including ones created outside ANAS), so that I have a complete picture of what's shared.

6.2. As a user, I want to see active SMB connections (who is connected, to which share, from where), so that I can monitor usage.

6.3. As a user, I want to see SMB global configuration (workgroup, server string, etc.), so that I understand the server-level settings.

6.11. [done] As a user, I want a "Details" view that shows how a client connects to a share — copy-pasteable Windows (`\\host\name`), macOS (`smb://…`), and Linux (`mount -t cifs …`) strings keyed off the node's real addresses (read from PVE's network API), plus the access summary and current connections — so I can hand connect instructions to users without looking up syntax. *(The `interfaces` picker in SMB Settings is populated from the same PVE network data — an empty pick list previously made it look broken.)*

#### Act
6.4. As a user, I want to create an SMB share pointing at a dataset or directory, with options and access controls configured together, so that the share is ready to use in one step.

6.5. As a user, I want to modify an existing share's settings (options, access controls), so that I can adjust behavior as needs change.

6.6. As a user, I want to modify SMB global configuration, so that I can change server-level settings like workgroup name.

6.6.1. [done] As a user, I want changing the SMB interface binding (`interfaces` / `bind interfaces only`) to be confirmation-gated when clients are connected — warning me how many and which clients may be dropped when smbd rebinds — while cosmetic edits (workgroup, server string) apply without a prompt, so I don't silently cut off active users. *(Only the binding change is disruptive: we `reload` smbd, not restart, so per-connection smbd processes survive a cosmetic reload. Signature is the `global` section only — the changed values are never bound into the confirm code.)*

6.7. As a user, I want to remove an SMB share from the configuration, so that I can revoke access to a path.

6.8. [done] As a user, I want ANAS to reload the SMB service after configuration changes, so that changes take effect without manual intervention. *(Already satisfied: `reloadSmbd()` runs as a side effect of every SMB mutation — the "service reloads are side effects of mutations, not separate API calls" principle. NFS's `exportfs -ra` (7.6) is the same.)*

---

## Epic 7: NFS Export Management

> As a user, I can create and manage NFS exports for Linux/Unix clients.

> **Status: shipped 2026-07-13.** 7.1–7.7 all done — round-trip /etc/exports parser, `/v1/shares/nfs*` routes (list-all, create/modify/remove via surgical `editConfig`, `exportfs -ra` side effect), and NFS rows in the unified Shares UI. Verified live: create → one-line append, confirmed delete → clean removal, `/etc/exports` byte-identical to pre-state.

### Stories

#### Dev (build first — parser)
7.7. As a dev, I want a round-trip /etc/exports parser (parse → modify → write) that preserves comments, whitespace, and unknown entries, so that surgical config editing works correctly.

#### Observe
7.1. As a user, I want to see all configured NFS exports (including ones created outside ANAS), so that I have a complete picture of what's exported.

7.8. [done] As a user, I want a "Details" view that shows how a client mounts an export — copy-pasteable `mount -t nfs host:/path …` and `/etc/fstab` lines keyed off the node's real addresses, plus the allowed-client summary — so I can hand mount instructions to users. *(Shares the unified Details window with 6.11.)*

#### Act
7.2. As a user, I want to create an NFS export for a dataset or directory, so that Unix clients can mount it.

7.3. As a user, I want to configure export options (client restrictions, read/write, sync/async, root squash), so that the export is appropriately secured.

7.4. As a user, I want to modify an existing export, so that I can adjust settings.

7.5. As a user, I want to remove an NFS export, so that I can revoke access.

7.6. As a user, I want ANAS to reload NFS exports after configuration changes, so that changes take effect without manual intervention.

---

## Epic 8: User & Group Management (for share access)

> As a user, I can manage the system users and groups that are needed for share access and permissions.

> **ARCHITECTURAL SEAM (lock in even for MVP): resolve users/groups via `getent`/nsswitch, NEVER by parsing `/etc/passwd`.** That makes identity source-agnostic — local, LDAP, or AD users all surface through the same abstraction once the box is configured (see Epic 14). PVE-realm (`@pve`) users have no UID and are NOT usable for file ownership; only system-resolvable users (getent) are. PVE realms authenticate to the PVE UI, which is a different thing from making a user own files.

> **SCOPE (decided 2026-07-14): "Minimal" — create share users, not login/PVE users.** A user ANAS creates has no login shell and no Unix password (`useradd -M -s nologin`); it owns files (NFS) and optionally holds an SMB password (`smbpasswd`). We do NOT write PVE's `user.cfg` or grant PVE login (a user we create is available for PVE to reference as `@pam` if the admin later chooses — we don't do it for them). Directory users (AD/LDAP) are consumed read-only via getent; in an AD deployment no local users are made at all. Endpoints live under `/v1/identity/*`.

> **Status: Unit 1 shipped 2026-07-14.** 8.1–8.6 done — getent/pdbedit-backed `/v1/identity/*` (enriched `ShareUser`/`ShareGroup` lists, source-agnostic; regular-user band [1000,60000)+root filters service accounts), create user (`useradd -M -s nologin`, no login/no Unix password), SMB password (`smbpasswd -s`, password on stdin — never argv), enable/disable, group create + membership, and the "Share Users" UI panel (directory users read-only). Verified live: full create → SMB password → group → disable lifecycle, password confirmed absent from the process list.

### Stories

#### Observe
8.1. [done] As a user, I want to see system users relevant to share access (filtering out system/service accounts), so that I understand the access landscape without noise.

#### Act
8.2. [done] As a user, I want to create a system user, so that they can access shares. *(Focused on share access, not full user administration.)*

8.3. [done] As a user, I want to create a group, so that I can organize share permissions.

8.4. [done] As a user, I want to add/remove users from groups, so that I can manage access at the group level.

8.5. [done] As a user, I want to set an SMB password for a user, so that they can authenticate to SMB shares.

8.6. [done] As a user, I want to disable a user's access without deleting them, so that I can temporarily revoke access.

> **User delete: deliberately OUT (decided 2026-07-14).** Deleting an identity that owns files orphans ownership + ACL entries and risks UID recycling (a new user reusing the freed uid inherits the old grants). Disable is the correct primitive — access is revoked but ownership stays attributable, no orphans, no recycling. Revisit only by request, and then as a scan-impact → confirm → reassign-or-orphan flow. Related and shipped regardless: the permissions editor (4.7.2) now flags an ACL/owner whose uid/gid no longer resolves (deleted outside ANAS, or a departed directory identity) as "unknown (uid N)" so it can be recognised and removed — `AccessEntry.unresolved`.

---

## Epic 9: Job & Operation Management

> As a user, I can monitor operations and be notified of outcomes through Proxmox's notification system.

> **Status (reviewed 2026-07-18): descoped — the epic predates the surfaces that made it redundant.** The 202-job machinery (Epic 0) remains the mutation transport, but a dedicated Jobs *menu* failed the earn-its-keep test: jobs are in-memory and ephemeral by design (a history view over that is a worse audit trail than journald, the designated audit log); interactive failures surface in the view the user is standing in; and everything long-running already has a feature-native home (scrub/resilver → pool Topology activity strip; replication runs → Replication view, deliberately systemd units rather than ANAS jobs; running jobs + failures → dashboard 2.4/2.5). A Jobs menu would be a second place to see the same things — exactly what the one-menu-per-feature rule prevents. The one slice with real value is **unattended**-failure notifications (9.4/9.5) — deferred, see below.

### Stories

9.1. [OBE 2026-07-18] As a user, I want to see all active jobs and their progress, so that I know what's currently happening. *(Dashboard jobs strip (2.4) + the owning feature's view cover this; no dedicated menu.)*

9.2. [OBE 2026-07-18] As a user, I want to see the history of completed and failed jobs since the last service restart, so that I can review recent activity. *(In-memory job history is ephemeral by design; durable history is journald + ZFS/systemd state per the principles.)*

9.3. [OBE 2026-07-18] As a user, I want to see the details of a job (who initiated it, what it did, when, result or error), so that I can audit operations. *(Audit is journald — structured, timestamped, with initiator — not a UI over a volatile store.)*

9.4. [deferred 2026-07-18] As a user, I want **unattended** failures (replication task failed or silently overdue) to generate Proxmox notifications, so that I'm alerted through whatever channels I've already configured (email, Gotify, etc.). *(Rescoped from "job failures" — interactive failures don't need notifications, the user is looking at them. Deferred pending a look at what PVE gives out of the box: PVE's notification system (targets/matchers) and ZED's own alerting may already cover or partially cover this — e.g. a failing `anas-repl-*.service` unit, scrub results via ZED. Evaluate the built-ins first; only wire what's genuinely missing.)*

#### Dev
9.5. [deferred 2026-07-18] As a dev, I want a Proxmox notification client that can send notifications through the PVE notification system, so that ANAS events reach users through their existing alert channels. *(Deferred with 9.4 — build only if the out-of-the-box evaluation shows a gap worth filling.)*

---

## Epic 2: Dashboard & System Overview

> Assembles data from Epics 3, 4, 6, 7, and 9 into a single-page overview. **Depends on the observe stories in those epics being built first** — the dashboard composes components, it doesn't build the data layer.

### Stories

#### Dev
2.6. [done 2026-07-15] As the dashboard page, I want a unified status endpoint in anasd (`GET /v1/status`) that aggregates pool health, share status, and disk state, so that I can render from a single API call instead of fanning out.

#### Compose
2.1. [done 2026-07-15] As the dashboard, I want a pool health summary component (from Epic 3), so that I can display pool status without knowing ZFS internals.

2.2. [done 2026-07-15] As the dashboard, I want a disk utilization component (from Epic 3), so that I can show space usage at a glance.

2.3. [done 2026-07-15] As the dashboard, I want a share status component (from Epics 6/7), so that I can show SMB/NFS service health and active shares.

2.4. [done 2026-07-15] As the dashboard, I want a recent jobs component (from Epic 9), so that I can show recent activity.

2.5. [done 2026-07-15] As the dashboard, I want a warnings/alerts component that surfaces degraded pools, failed scrubs, and disk errors prominently, so that problems are impossible to miss.

2.7. [done 2026-07-15] As a user, I want ZFS-specific performance telemetry on the dashboard (ARC hit ratio & size, L2ARC, per-pool `zpool iostat` throughput/IOPS, compression ratio, live scrub/resilver rate), so I get the storage insight TrueNAS gives that PVE's generic RRD graphs don't. *(Do NOT duplicate PVE's node CPU/mem/disk-IO graphs — Principle 15. Principle 7 tension: prefer live on-demand sampling while the panel is open, or PVE's RRD, over a background collector; persisted history is a separate discussion. Data sources: /proc/spl/kstat/zfs/arcstats, `zpool iostat`.)*

---

## Epic 10: System Setup & Configuration

> As a user, I can install ANAS on my Proxmox system quickly and have it integrate automatically.

> **Status (reviewed 2026-07-18): effectively shipped via `packaging/` — most stories OBE.** Distribution is a release tarball (`make-release.sh`: build → pruned prod-only node_modules → boot smoke test → `anas-<version>.tar.gz`) installed by `packaging/install.sh` (read-only preflight → transactional install with ERR-trap rollback → health check → PVE UI integration, verified). Proven on the real pve5 node. The npm-registry/CLI-subcommand framing below is superseded, not missing. 10.10 (semantic versioning) shipped 2026-07-18, including the GitHub Actions release pipeline (`.github/workflows/release.yml`): tag push `vX.Y.Z` → CI runs make-release (drift guard + boot smoke test) → tarball attached to the GitHub Release. Live-proven with v0.1.1. **Epic complete.**

### Stories

10.1. [OBE 2026-07-18] As a user, I want to install ANAS with a single command (`npm install -g anas`), so that deployment is simple. *(Superseded: distribution is the release tarball + `install.sh` — an npm registry package can't carry the systemd units, PVE UI injection, or preflight. Single command achieved anyway: untar, `sudo ./install.sh`.)*

10.2. [OBE 2026-07-18] As a user, I want `anas setup` to detect Proxmox, configure systemd units, set up TLS, and generate default config, so that the system is ready to use with minimal intervention. *(install.sh Phase 0 preflight detects PVE node, Node ≥ 20, ZFS ≥ 2.2 for `zpool -j`, acl, samba/nfs, port collisions; Phase 1 installs units incl. TLS wiring. No default config to generate — the system is env-driven and stateless.)*

10.3. [OBE 2026-07-18] As a user, I want `anas setup` to install the PVE UI integration (Epic 13's scripts), so that ANAS is accessible from the Proxmox interface after a standard install. *(install.sh step 5: saves pristine `index.html.tpl.anas-orig`, runs the pve-integration installer, verifies `anas.js` + script line landed.)*

10.4. [done] As a user, I want ANAS to use Proxmox TLS certificates automatically, so that I don't need to manage separate certs. *(Pulled forward: PVE marks PVEAuthCookie as Secure, so browsers withhold it from plain-HTTP ANAS — HTTPS with the host's certs is a prerequisite for auth to work at all. Implemented in the systemd unit via NITRO_SSL_CERT/KEY from /etc/pve/local, preferring pveproxy-ssl.\* like pveproxy. `anas setup` in 10.2 must install the same configuration.)*

10.5. [OBE 2026-07-18] As a user, I want to override defaults (port, TLS, auth provider) via `/etc/anas/config.yaml`, so that I can customize the deployment when needed. *(Deliberately not built — a yaml config layer is undifferentiated code. Overrides exist as env vars (`--prefix`, `HEALTH_PORT`, `NODE_BIN` at install; unit environment at runtime), and the standard mechanism for the rest is a systemd drop-in.)*

10.6. [OBE 2026-07-18] As a user, I want to run `anas doctor` to validate my environment (Proxmox version, ZFS availability, Samba/NFS installed, TLS certs, config sanity), so that I can diagnose problems without guessing. *(install.sh's read-only preflight IS the doctor at install time: aborts with a clear summary of everything wrong, node untouched. A post-install runtime doctor doesn't exist; runtime problems surface through the dashboard, health endpoint, and journald. Revisit only if a real diagnosis gap shows up in the field.)*

10.7. [OBE 2026-07-18] As a user, I want `anas doctor` to fix what it can automatically and clearly explain what it can't (with actionable guidance), so that I can resolve issues quickly. *(`install.sh --install-deps` is exactly this: auto-installs Node 22 via NodeSource and acl; everything it can't fix aborts preflight with actionable per-item messages.)*

10.8. [OBE 2026-07-18] As a user, I want to upgrade ANAS (`npm update -g anas`) and have services restart cleanly, so that upgrades are simple and low-risk. *(Re-running install.sh is a transactional in-place upgrade: stop → backup `/opt/anas` → install → health check → drop backup, with ERR-trap rollback restoring and restarting the previous install on any failure. Version-awareness — "upgrading X → Y", downgrade warning — lands with 10.10.)*

10.10. [done 2026-07-18 — incl. the GitHub Actions release workflow, live-proven: tag push v0.1.1 → CI make-release (drift guard + smoke test) → tarball attached to the GitHub Release] As a dev, I want semantic versioning with a single source of truth, so that a release's tarball name, git tag, and the version the running system reports can never disagree. *(Shipped: `packaging/bump-version.mjs` (`npm run version:bump -- X.Y.Z`) syncs all copies + lockfile; make-release verifies no drift, refuses a dirty tree, and tags `vX.Y.Z` (`--dev` for untagged iteration builds); the tarball ships `app/VERSION` so installs carry `/opt/anas/VERSION`; install.sh logs fresh/reinstall/upgrade transitions and gates downgrades behind a confirm. Verified: bump round-trip, drift guard, dirty-tree gate, and all three install transition paths. Original problem: the version lived in five hand-synced places: root package.json, the three workspace package.jsons, and `VERSION` in `packages/shared/src/index.ts` — which is what the gateway/daemon health and status endpoints actually report; the tarball's VERSION file isn't copied into `/opt/anas`, so an installed node can't say what release it runs except via the API. Scope: root package.json is the single source; a bump script/build step syncs the workspaces and generates the shared `VERSION` const; make-release refuses a dirty tree and tags `vX.Y.Z`; install.sh stamps VERSION into the prefix and logs the from→to transition, warning on downgrade. **Ultimately GitHub Actions builds the release artifacts** — tag push `vX.Y.Z` → CI runs make-release (incl. the boot smoke test) → tarball attached to the GitHub Release; `make-release.sh` remains as the local/CI-shared build core.)*

#### Dev
10.9. [OBE 2026-07-18] As a dev, I want the `anas setup` and `anas doctor` commands implemented as CLI subcommands (not part of the web app), so that they can run before the services are started. *(Requirement was "runs before the services exist" — the bash installer satisfies it without building a CLI framework.)*

---

## Epic 13: PVE UI Embedding (ExtJS-native)

> As a user, I want ANAS to appear as a native section of the Proxmox web UI (Ceph-style collapsible node menu group with native ExtJS panels), so that managing storage feels like part of Proxmox, not a separate app.

> **Pivot (July 2026):** the first iteration embedded the Nuxt/Vue app in iframes with a postMessage ticket handoff (stories 13.1–13.3, built and verified). User review rejected the iframe approach — the style clash and foreign interaction patterns read as a separate app. ANAS now follows the Ceph model end to end: native ExtJS panels, `anas` reduced to a pure API gateway with PVE-style server-side node forwarding. See DESIGN.md "UI: Native PVE Panels" and "Public API". The injection mechanism and installer (13.4/13.5) carry forward unchanged.

### Stories

#### Web app (independent of PVE-side work)
13.1. [done→OBE] As a user, I want each top-level view (dashboard, pools, disks) served at a stable route (`/`, `/storage/pools`, `/storage/disks`), so that views are deep-linkable and embeddable. *(Future epics add their own views following this pattern.)*

13.2. [done→OBE] As a user, I want an embedded display mode (`?embedded=1`, persists across in-app navigation) that hides ANAS chrome, so that ANAS views render cleanly inside the PVE UI.

13.3. [done→OBE] As a user, I want ANAS to accept my PVE session via the postMessage ticket handoff (`/auth/handoff` page, unauthenticated, origin-verified, redirect-validated), so that embedded views authenticate without a separate login — including for nodes other than the one serving my PVE session.

#### PVE side (independent of web-app work)
13.4. [done] As a user, I want an "ANAS" collapsible section in the PVE node menu (Dashboard, Storage → Pools/Disks) whose items render embedded ANAS views, so that ANAS is reachable from where I already work. *(Fail-open: script errors must never break the PVE UI.)*

13.5. [done] As a dev, I want idempotent install/uninstall/re-apply scripts for the integration (JS file + tpl insert + apt post-invoke hook), wired into the stunt-node deploy, so that the integration survives pve-manager upgrades. *(Productization into `anas setup` remains stories 10.2/10.3.)*

#### Verification
13.6. [done] As a dev, I want integration tests that log in through the real PVE UI, expand the ANAS section, and verify the embedded pools/disks views render and function, so that the whole chain (injection → handoff → embedded view) is continuously verified.

13.7. [OBE] ~~As a user, I want embedded ANAS to match the PVE theme (light/dark), so the integration is visually seamless.~~ *Native ExtJS panels inherit the PVE theme by construction.*

#### ExtJS-native rework
13.8. [done] As a dev, I want anas reduced to a pure API gateway — no pages, PVE-origin CORS with credentials, and `/api/nodes/<node>/v1/*` routing (local node → anasd socket; other nodes → forward to that node's gateway with the user's ticket, TLS verified against the cluster CA) — so the browser only ever talks to the UI host and cross-node works the PVE way.

13.9. [done] As a dev, I want an ExtJS panel framework in packages/pve-integration (loader, per-view files concatenated by the installer, shared API helper, "ANAS is not installed on this node" probe/panel), so that views have a consistent foundation and missing installs degrade gracefully like Ceph.

13.10. [done] As a user, I want the Pools view as native ExtJS (grid of pools; detail window with topology, properties, scan status; Start Scrub action via the job API), so that pool management has parity with the retired Vue views inside the PVE UI.

13.11. [done] As a user, I want the Disks view as native ExtJS (grid with usage/health; SMART detail window), so that disk visibility has parity with the retired Vue views.

13.12. [done] As a user, I want a minimal ANAS Dashboard panel (gateway health, pool states, active jobs), so that the ANAS section has a landing view. *(Full dashboard remains Epic 2.)*

13.13. [done] As a dev, I want the Nuxt web app retired (pages, components, embedded mode, handoff removed; gateway extracted; deploy/dev scripts and docs updated), so that there is exactly one UI surface to maintain.

13.14. [done] As a dev, I want dev and integration tests reworked for the native panels (PVE login → ANAS section → panels render real data; not-installed path; scrub flow through the ExtJS UI), so that the new chain is verified end to end.

13.15. [done] As an operator, I want the injected bundle cache-busted (`?v=<content-hash>` stamped at install) so "install → see the change" is reliable and an upgrade never serves a stale cached bundle — the unversioned tag cost a real debug detour, and same-version test cuts guaranteed it. *(Token = first 12 hex of `sha256sum` of the generated `anas.js`; deterministic — changes iff content changes. The tpl step is now insert-OR-update: no tag → insert with `?v=`; tag present (any/no `?v=`) → re-stamp to the current hash; same content → same hash → no-op. pveproxy ignores the query string, so it is a pure browser cache-buster. Uninstall/re-apply and the apt hook all handle the suffix. Verified by `test/tpl-inject.test.sh`.)*

---

## Epic 15: `ANAS.gfx` — Graphical Visual Language (backlog)

> As a user, I want ANAS's storage views to use a purpose-built graphical language — SVG hardware objects, capacity gauges, health states — instead of plain grids, so the physical/spatial reality of my storage is legible at a glance in a way tables can't convey.

**Direction decided 2026-07-14** (validated via three local HTML spikes in scratchpad — composer, pools-status, datasets-tree). Key findings/decisions:
- **SVG + DOM, not canvas** — canvas has no DOM nodes → no `anas-*` test hooks, no CSS theming, no accessibility. SVG objects on themed ExtJS chrome give crisp vector icons (HDD/SSD/NVMe), testability, and PVE light/dark theming for free. Drag is ~40 lines of Pointer Events (validated); Interact.js (vendored UMD in the concat) is optional polish, not load-bearing.
- **A shared layer, not one-offs**: build `ANAS.gfx` once — disk/vdev icon set + health palette + capacity gauge/bar + node-drag toolkit + tree-enrichment helpers — consumed by every graphical view so a faulted disk (etc.) looks identical everywhere.
- **Graphics where they add insight, tables where density wins** — target Pools/Disks/Composer/Datasets; keep Shares/Users/Jobs tabular (hybrid: graphical hero + tabular detail).
- **Skeuomorphic-but-restrained**: objects carry their own material gradients; the UI chrome themes around them.

### Stories (to be detailed when scheduled)
15.1. [done 2026-07-14] `ANAS.gfx` foundation — the shared SVG icon set, palette, gauges, drag toolkit, packaging, test-hook conventions. *(Shipped in packages/pve-integration/src/15-gfx.js; validated in the real PVE page via a temporary gfx-check panel + Playwright smoke, since removed.)*
15.2. [done — create-side 2026-07-14] **Pool Composer** (build-side of 3.23 — the flagship): draft topology, drag-to-bay, live capacity/redundancy, validity gating (special/log redundancy enforced), pool advisor. Launches from the Pools "Create" action; commits one `CreatePoolRequest`. **Verified live: the graphical composer created a real ZFS pool on the stunt node.** *(Gaps deferred: (a) **special/dedup vdevs are not yet creatable** — `CreatePoolRequest` has no special/dedup field and the daemon's `buildCreateArgs` emits only data/log/cache/spare; the composer offers the Special role but blocks commit with a clear reason rather than silently dropping disks. Resolving this = finishing the API side of 3.22 (schema field + `zpool create … special mirror …` args). (b) **Expand mode** is implemented but not wired to a toolbar button, and `AddVdevRequest` carries no role so it can only add data vdevs — needs a role field for log/cache/spare/special expansion.)*
15.3. [done 2026-07-14] **Pools status view** — the monitor-side twin: grid state pills + capacity bars; a graphical **Topology** panel in the pool detail (one `gfx.bay` per vdev, a `gfx.diskCard` per member colored by *live* health so a faulted drive shows red in its physical bay position), capacity gauge, scrub/resilver `gfx.activity` strip, and an advisor `gfx.callout` naming bad members. The per-disk READ/WRITE/CKSUM tree is retained below as "Device Errors". *(Gaps: `PoolDetail` carries no per-disk `kind`, so every disk tile renders as the HDD object (gfx's unknown-kind default) — lighting up SSD/NVMe tiles needs `kind` on `PoolDetail`; also no per-disk size, so the tile sub-line shows a live error/state summary instead. A disk that is `ONLINE` but reporting errors is intentionally colored red, consistent with the existing row tint. Nice-to-have: a `gfx.bayGroup(label, bays)` helper — the role-group wrapper is the only hand-rolled inline markup.)*
15.4. [done 2026-07-14] **Datasets enriched tree** — retrofit into the *existing* ExtJS treepanel (not a rewrite): pool/folder gfx object icons + a distinct pool-root row band, a **Space of pool** `gfx.bar` column, a **Properties** column (compression/ratio + snapshot-count `gfx.chip`, SMB/NFS `gfx.badge`), always-visible per-row `gfx.ctl` action icons (add/snapshot/share/lock/props/trash) delegated to the existing handlers, and a pool-space **donut** hero that refocuses on the selected node's pool. *(Gaps: the flat `GET /pools/:name/datasets` feed carries no share info, so SMB/NFS badges are dormant until `shares` is added to that feed — badges omit gracefully when absent. Snapshot-count chip is best-effort — it counts loaded snapshot child rows, so it appears only after a dataset is expanded.)*
15.5. Extend the language to the **Dashboard** (Epic 2) and Disk Health (3.20) as the vocabulary matures. *(Disk Health portion done 2026-07-14: the Disks grid now leads each row with a skeuomorphic `gfx.icon` disk object — hdd/ssd/nvme by `transport`/`rotational`, colored by the fused `healthStatus` (SMART+ZFS) with a corner health dot, faulted drives greyscaled. Dashboard done 2026-07-15: rebuilt from the placeholder into the full Epic 2 dashboard — pool-health donuts/pills, fleet health, shares/jobs, warning callouts, and the live telemetry headline (ARC gauge, per-pool/disk I/O bars + sparklines with latency, network throughput) on GET /v1/status + /v1/telemetry.)*

---

## MVP Scope

For V1 MVP, the implementation order is:

1. **Epic 0** — Foundation *(done)*
2. **Epic 0.5** — Test infrastructure *(done — stunt node, Playwright)*
3. **Epic 1** — Auth *(done — PVE RSA-SHA1 verification; sidebar deferred to Epic 10)*
4. **Epic 3** — ZFS pools (core value proposition — parsers first, then observe, then act)
4.5. **Epic 13** — PVE UI embedding, ExtJS-native (establishes the panel framework and gateway API shape all later epics' views build on; do 13.8–13.14 before starting Epic 4 UI work)
5. **Epic 4** — ZFS datasets (builds on pool infrastructure)
6. **Epic 5** — Snapshots (builds on dataset infrastructure)
7. **Epic 6** — SMB shares (parser first, then CRUD)
8. **Epic 7** — NFS exports (parser first, then CRUD)
9. **Epic 8** — Users & groups (required for share security)
10. **Epic 9** — Jobs UI *(descoped 2026-07-18 — dedicated menu OBE, feedback is feature-native + dashboard, audit is journald; unattended-failure notifications (9.4/9.5) deferred pending evaluation of PVE/ZED built-ins — see epic status note)*
11. **Epic 2** — Dashboard (composes components built in 3–9; last because it depends on everything)
12. **Epic 10** — Setup & packaging *(done 2026-07-18 via `packaging/` tarball + install.sh + semver + Actions release pipeline (10.10) — V1 MVP complete; releases at github.com/ccebelenski/anas/releases)*

Stories marked *(V2?)* are explicitly deferred.

---

## V2 Backlog

> **V2 priorities (operator call, 2026-07-18): homelab first.**
> 1. **Epic 16 (PBS file backup) COMPLETE 2026-07-19** — designed from the operator's real scripts and live-proven against a disposable PBS, all in one arc. **Epic 18 (Mounts) COMPLETE 2026-07-18** — remote shares live-proven same-day; 18.4/18.6/18.7 descoped (NAS layer, not a Linux-mount manager). Next up: **Epic 11 + AHR** (the headline) and **Epic 17** (schedules).
> 2. **Epic 11 + AHR** — promoted to the V2 headline: a Synology alternative. Mixed-drive-size arrays with **online expansion** matter precisely because disks are expensive — grow-as-you-buy beats forklift upgrades, and it's the thing neither ZFS nor PVE offers.
> 3. **Epic 17** (scheduled snapshots & scrubs) — inked as its own epic 2026-07-18 (it needs a new screen); TrueNAS-parity table stakes, cheap relative to value — the replication timer/task-store machinery is the template.
> 4. **12.1** (version-skew checks) — the one Epic 12 survivor; rides early ("easy now" post-10.10, and upgrade pain compounds as versions accumulate).
> 5. **Epic 14 + NFSv4 ACLs (4.7.1)** — deferred as enterprise features; revisit when demand appears.

### Epic 11: md (mdadm) Storage Management

> As a user, I can create and manage Linux software RAID arrays with md for environments where ZFS isn't appropriate.

> **Priority: promoted 2026-07-18 (operator call) — Epic 11 + AHR are the V2 headline.** The draw is the Synology-alternative story: SHR-style mixed-size arrays and, above all, **expanding an existing array** — huge when disk prices make buy-all-drives-up-front painful. Epic 11's md basics are the prerequisite layer for SHR.

md provides RAID without ZFS's memory overhead, using standard Linux filesystems (ext4, xfs). This involves managing multiple layers: mdadm arrays, filesystem creation/formatting, mount points, and /etc/fstab. The share management side (SMB, NFS) is reusable — a path is a path. The storage management UI needs parallel workflows for md vs ZFS.

#### Stories (inked 2026-07-23; md basics are internal build stages of AHR, not a separate release)

11.1. [done 2026-07-22] As a dev, I want stage-0 ground truth: BUILD the full stack on the stunt node with mismatched virtual disks and drive expansion/convert/replace/failure/reboot drills on throwaway data. *(docs/AHR-GROUND-TRUTH.md, 17 numbered facts; §9 questions closed.)*
11.2. [done 2026-07-22] As a dev, I want the pure-computation layer: shared Zod schemas + the fresh-create banding and incremental expansion planners, exhaustively tested. *(packages/shared schemas/ahr.ts, daemon services/ahr-layout.ts.)*
11.3. [done 2026-07-23] As a dev, I want the read layer built on captured ground truth: mdstat/mdadm/LVM/btrfs parsers with real fixtures, partition geometry, the live topology reader, and GET /v1/ahr + layout preview. *(GT-13 formats; everything keyed by-id/UUID.)*
11.4. [done 2026-07-23] As a user, I want md events and AHR job milestones delivered through PVE's notification system with zero polling. *(mdadm.conf PROGRAM hook + PVE::Notify templates, GT-11/GT-17; installer ships mdadm/btrfs-progs per GT-1.)*
11.5. [done 2026-07-23 — live-proven 11.8] As a user, I can create, scrub, and destroy an AHR pool through the API/UI with confirm-gated safety listing every disk wiped.
11.6. [done 2026-07-23 — live-proven 11.8] As a user, I can expand a pool (add/replace disks) as a resumable multi-layer job — plan preview, degraded-refusal, halt/resume/abandon, the GT-8 boot recovery ladder — with the pool online throughout.
11.7. [done 2026-07-23 — deployed to stunt node; operator visual review pending] As a user, I get the AHR UI: Hybrid RAID menu, banded create composer with live layout preview, layered pool detail, expansion wizard with before→after and pending-capacity truth.
11.9. [done 2026-07-23] As a user, when a disk that fell offline comes back healthy, I want a guided **Re-add** (detect faulty-but-present members; `mdadm --re-add` rides the write-intent bitmap for a differential catch-up — the md analog of a ZFS resilver — falling back to a full member rebuild with the difference stated in the confirm), so a transient blip doesn't cost a day of rebuild or require the CLI. *(Inked 2026-07-23 from operator design review; arrays now carry explicit `--bitmap=internal` as the prerequisite.)*

11.8. [done 2026-07-23 — full lifecycle through the real API on the stunt node: adopted the hand-built pool, destroyed it, created tank (RAID5×3+RAID1×2), expanded with live RAID1→RAID5 convert, replaced a disk live, scrubbed; canary data intact; pins/hook/intent verified; 2 live-proof catches fixed at source (btrfs path, ghost-superblock resurrection)] As a dev, I want the whole arc live-proven end-to-end on the stunt node through the real API (create → expand → replace → destroy on throwaway data) before any release gate.

11.10. [done 2026-07-23 — live-proven on the stunt node through the real API: healthy pool adds nothing; a genuinely degraded pool cards target-first with band + FULL (untruncated) member id; an md auto-rebuild-onto-spare rides in-progress and does NOT card (at-source fix: arrayState treated any activeDevices<raidDevices as degraded — a running `recovery` now reads `recovering`/pool `rebuilding`, matching §10 "rebuild → no new surface" and the §3 "initial build ≠ degraded" intent); consumed-spare + flat-layout advisories confirmed non-carding. Halted-expansion card NOT live-driven (forcing a deterministic mid-pipeline step failure on seconds-fast virtual arrays isn't reliably reproducible; the card + its collectAhrWarnings intent-wiring are unit-tested and share the exact path live-proven for degraded)] As the dashboard, I want an AHR source in the status aggregate (fail-open like every source) — one target-first warning card per pool in a bad state (`degraded` naming the band+member, `failed`, `readonly`, halted expansion naming Resume/Abandon), in-progress ops riding the existing jobs strip, healthy pools adding NOTHING — so AHR problems are impossible to miss without dashboard noise. *(Design: AHR-DESIGN §10; spare-consumed and flat-layout advisories deliberately do not card.)*

11.11. [done 2026-07-23 — live-proven end-to-end through the real API: a too-small spare refused with the EXACT shortfall (needs 2 GiB top boundary, has 1 GiB, 1 GiB short); a big-enough spare attached (409 confirm → 202), (S) in every band's mdstat, API role:'spare' with all band slices, rawBytes EXCLUDES it; then a real member `mdadm --fail` → md AUTO-rebuilt onto the spare slice with zero ANAS involvement → after rebuild the spare became a member, consumed-spare advisory present, pool NOT degraded, no dashboard card; cleared via product verbs (pulled the dead disk → its absent slot auto-dropped → attached a fresh full-coverage spare)] As a user, I can attach full-coverage hot spares to an AHR pool (usable size ≥ the top array boundary — partial spares refused with the exact shortfall; slices `--add-spare`'d to every band so **md owns the automatic failover**), remove them confirm-gated, see them as a labeled spare bay excluded from rawBytes, and trust that expansion auto-extends spare coverage to new bands — so a disk failure starts rebuilding immediately with no operator in the loop. *(Design: AHR-DESIGN §11; promote-to-member and shared spares OUT of v1.)*

11.12. [done 2026-07-23 — live-proven end-to-end through the real API on the stunt node; snapshot fixtures NOW REAL captures (btrfs-progs v6.14, replacing the synthetic modellings — NOTES.md updated). Proven: a flat pre-§12 pool reads `subvolLayout: false` and refuses snapshot create (409 flat-layout message); a fresh pool builds @data/@snapshots, fstab carries `subvol=@data`, API `subvolLayout: true`; default-timestamp + named snapshots list readonly:true with sane createdAt; rollback (409 confirm → 202) reverted the canary, preserved the modified state as `pre-rollback-<ts>`, remounted, destroyed nothing; delete (confirm) + invalid-charset refusal (400); nothing left mounted at /run/anas-ahr after any op. TWO at-source fixes caught live: (1) findmnt appends `[/@data]` to a subvol mount's source — the topology reader's exact source-match missed it and fell back to options-less lsblk, reporting EVERY subvol pool as flat; now strips the suffix. (2) the list used `btrfs subvolume list -s`, but a `pre-rollback-*` preserve of a `create`d @data is a PLAIN subvolume invisible to `-s` — the very state rollback promises you can return to was unlistable; now enumerates the plain list (otime from -s, readonly from -r)] As a user, I get btrfs snapshots on AHR pools: new pools create an `@data`/`@snapshots` subvolume layout (snapshots live outside the mounted tree), I can list/create/delete snapshots and roll back — rollback preserves the replaced state as `pre-rollback-<ts>`, destroying nothing, ever — and pre-design flat-layout pools report `subvolLayout: false` with snapshots unavailable (no migration verb; destroy/recreate is the migration). *(Design: AHR-DESIGN §12; qgroup sizes OUT of v1.)*

11.13. [done 2026-07-24] As the dashboard, I want healthy AHR pools present in the headline Pools section with the same structural presence ZFS pools get — one block per pool (AHR badge, state, used/usable capacity, mountpoint, pool → band → member-disk composite, spare bay, click-through to Hybrid RAID) fed by `ahrPools` in `/v1/status` (fail-open) — so an AHR pool reads as calm, not absent. *(Operator design revision 2026-07-24 after live stunt review; supersedes §10's "healthy pools add nothing / no capacity tile". No AHR I/O strip — telemetry is zpool-based; render without it rather than show a wrong number. Warning cards stay failure-only.)* **Capacity-card parity included** (2026-07-24, parallel construction): a filling AHR pool now cards like a filling ZFS pool — identical ≥95% critical / ≥90% warning thresholds, same `capacity` category and "AHR pool 'tank' is 94% full" wording, derived from these same briefs (an unmounted pool with no `usedBytes` produces no card).

11.14. [done 2026-07-24] As a user composing an AHR pool, I want disk selection by **dragging disk cards** — the exact ZFS vdev-composer idiom (`ANAS.gfx` drag toolkit, same cards, same ineligible treatment) with one drop target (the planner does the banding) — in the create composer, the expand wizard, and spare attach (drag onto the spare bay), so building an AHR pool feels like building a ZFS pool. *(Operator design revision 2026-07-24 — parallel construction; supersedes §6.1's deliberate checkbox choice. Invalid drops refused in place with the stated reason; live preview updates per drop.)*

11.15. [done 2026-07-24] As the dashboard, I want AHR pool blocks to carry the SAME live I/O strip ZFS pool blocks have — pool aggregate + per-band + per-member read/write throughput, IOPS, and latency — so an AHR pool reads as busy/idle at a glance, not as a structurally-present but I/O-blind block. *(Closes the last parallel-construction gap and supersedes §10's "live I/O stays ZFS-only" caveat. `/v1/telemetry` gains `ahrPools` in the ZFS `pools` IoStats shape, name-matched to the `/v1/status` briefs — the AHR analog of ZFS's status↔telemetry flow — derived from two `/proc/diskstats` samples ~1s apart (the zpool-iostat sampling model) for the pool LV (dm), each band's md array, and each member disk; device names resolved at sample time from the `/dev/md/<pool>-r<N>` pins + LV mapper path (point-of-use kernel-name rule). **Latency is `await` (tick-delta / io-delta), stated honestly** — diskstats gives total wait, not ZFS's service-time split. Ground-truth: real `/proc/diskstats` captured on the stunt node (pool `tank`, 80 MiB write) BEFORE writing the parser, committed as fixtures. Blocks without a sample yet render without the strip — never fake zeros; `ahrPools` fail-open `[]` independently of ZFS telemetry. **Also in this commit:** a `gfx.timeChart` y-axis fix — long labels like "75.37 MiB/s" (11 chars) were right-anchored at a fixed 52px left margin and spilled past the SVG's left edge, losing leading digits (operator saw "5.37" on a live pve5 screenshot); the margin is now derived from the widest rendered Y label (value scale computed before the margin), floor 52, verified by a render harness at 37–999 MiB/s scales.)*

11.16. [done 2026-07-27] As a user, I want the **uniform commit-gate + live-recalc** across every composer: any warning flips the green ready-chip to amber '⚠ review to continue' and lists the warnings in the existing wipe-confirm ('Create/Expand anyway'), via ONE shared helper wired into ZFS create + AHR create + AHR expand; and **AHR expand goes live** — the separate 'Plan' button is dropped for recalc-on-drop matching create. *(Operator 2026-07-27; AHR create is the visual reference. Supersedes the earlier 'block stranded disks from selection' idea — never block, always warn-and-confirm.)*

11.17. [done 2026-08-02, check-discrimination added 2026-08-04] As an operator whose AHR sync has finished, I want the **RebuildFinished notification to say what actually finished and how it went**. mdadm --monitor names EVERY sync op "Rebuild*", so the hook reads `last_sync_action` to discriminate: a **check** (the scheduled mdcheck scrub) reports "md check finished … routine, no disk was rebuilt" + the `mismatch_cnt` (0 ⇒ info; >0 ⇒ WARNING advising an ANAS Scrub for file attribution); a **real rebuild** checks md's bad-block list (`/sys/block/<md>/md/dev-*/bad_blocks`) — ranges recorded ⇒ WARNING with "N unreadable sector range(s) … run a Scrub to identify any affected files", clean ⇒ "reconstructed everything exactly" + a precaution note. *(Operator 2026-08-02: recommend, never enforce — a scrub is a many-hour/day operation, and a clean BBL means parity reconstruction was mathematically exact. Operator 2026-08-04, live on pve5: the monthly mdcheck windows arrived as "RebuildFinished" alerts — "alarming and confusing"; hence the check branch. Journald record gains `ACTION=`/`MISMATCHES=`/`BADBLOCKS=`. Fail-open: unreadable sysfs degrades to the generic precaution wording. Deliberately NOT built: auto-scrub-after-rebuild (rejected), scrub file-path attribution and the scheduled-scrub btrfs phase remain shelved candidates.)*

11.18. [done] As a user looking at a pool's Details, I want each band array's **member partitions on demand** — a collapsed "▸ N members" affordance on every array row that expands to one line per member: the **FULL partition by-id, never truncated** (it embeds the disk identity — `…ST20000NM002C-3X6103_ZXA222KP-part2` tells you which physical disk this band slice lives on) plus that member's own state (in sync / rebuilding / spare / faulty / missing, the bad two in danger styling) — so "which partitions form this band" is answerable without hunting through slice-bar tooltips, and per-member sync state finally has a home instead of only the aggregate "(N in sync)" count. Collapsed by default: the row keeps its shape, and the detail is one click away. *(Operator design choice 2026-08-09 from a mockup review; pure UI — `arrays[].members[].partition` and `.memberState` were already in the §3 API, no daemon or schema change. No per-member size column: every slice in a band equals the band height already on the row. **Parallel-construction divergence, deliberate:** ZFS vdev members ARE whole leaf devices, so its member rows need nothing extra — AHR members are partitions, and the UI diverges exactly where the technology does. Native `<details>`/`<summary>` rather than bespoke expander machinery, so there is no expander state to lose across a Reload.)*

11.19. [done] As an operator watching a pool build on the dashboard, I want the **AHR pool block to describe a band as truthfully as the Details view does** — the band's **slice size on its member tiles** (a 20 TB member of a 7.28 TiB band read "Size 20.01 TiB", the disk's whole size answered against a band it dwarfs), the **band height** in the header, the band array's **own state pill**, and a **live sync strip** (percent / speed / ETA, or "queued behind another band") — so a pool mid-build reads as building rather than as a puzzle. *(Operator, live on pve5 2026-08-09 during the first mixed-media create. The juxtaposition it fixes: the band's own I/O read ~0 while its member tiles each pushed ~200 MiB/s — both numbers are RIGHT. md-level recovery traffic is invisible in the band array's counters **by definition** (the rebuild is the md layer's own work, not filesystem I/O flowing through it), and the LVM label-scan blips on idle members are **real kernel counters**, not artifacts — nothing to suppress or explain away. The sync strip is what makes the pair legible instead of alarming: "rebuilding 1.8% · 196.9 MiB/s · ETA 10h" turns a contradiction into a story. **Pure projection, no new system reads:** `heightBytes`/`state`/`sync` were already in hand on the `AhrArray` the brief is built from and were simply dropped; `AhrBandBrief` now carries them. All three are **OPTIONAL** for version skew (the 0.2.0↔0.2.1 additive-field precedent): a new UI against a pre-0.2.4 daemon renders exactly today's block — no height, no pill, no strip, the tile falling back to "Size <disk>" — with no errors and no blank strips. A QUEUED band is derived client-side as `state === 'recovering' && !sync`, which leans directly on issue #9's DELAYED semantics. Closes the last AHR-internal parallel-construction gap: the dashboard and Details now describe a band identically.)*

#### AHR — ANAS Hybrid RAID (SHR-style; V2 headline — promoted from "far future" 2026-07-18)

> As a user, I want Synology-SHR-style mixed-drive-size pooling with redundancy and online growth, so I can use drives of different sizes efficiently and expand incrementally — the thing ZFS fundamentally can't do (raidz is fixed-width to the smallest disk).

**Design: docs/AHR-DESIGN.md** (reviewed w/ operator 2026-07-22: named **AHR** — can't ship the "S"; btrfs-only (ext4 = Synology vestige, dropped); tier conversion excluded; incremental expansion planner added (fresh-create banding ≠ expansion — existing bands are constraints); `mdadm --replace` for live-disk replace; backup-file-free reshapes mandated; resume = recompute-and-continue with only the approved-disk-set intent persisted. Next gate: stunt-node ground truth). The stack (bottom→top): **partition each disk into size-matched regions → one mdadm array per region (RAID5=AHR-1 / RAID6=AHR-2; redundancy lives HERE) → LVM concatenates the arrays into one logical volume → btrfs as the filesystem.** Critical design fact: redundancy is md's job; **btrfs is only the filesystem, NEVER btrfs-RAID5/6** (unstable) — btrfs runs on a single already-redundant LVM volume.

The differentiated work (per Don't-Build-Undifferentiated: we wrap mdadm/LVM/btrfs, we build the orchestration no open tool provides):
1. **Layout algorithms** — fresh-create region partitioning for arbitrary drive sizes, plus the incremental expansion planner (existing bands are immutable constraints), respecting AHR-1/AHR-2 minimum-overlap-per-region.
2. **Online growth (the hard/dangerous part)** — add/replace-with-bigger drive → re-partition + `mdadm --grow` + `pvresize`/`lvextend` + `btrfs resize`, as a long-running, RESUMABLE, multi-layer job where each layer can fail independently.
3. Degraded/recovery handling across all three layers.

Real prosumer draw (mismatched-drive efficiency), but big and data-integrity-sensitive. Builds on the md basics above; PVE offers nothing comparable. *(Kickoff plan, 2026-07-20: SHR IS the headline — the md layer is an internal build stage of it, not a separate release (pure mdadm is uninteresting; end users would just use ZFS). Ground truth = BUILD the stack ourselves on the stunt node with mismatched-size virtual disks (SHR is orchestration over an open mdadm→LVM→btrfs stack, nothing proprietary), then drive a real expansion — including failure/resume paths — on throwaway data, watching /proc/mdstat + pvs/lvs + btrfs resize. (NOT a Synology: the operator's is pro-level HW without SHR, and non-disruptable — and unneeded: SHR's orchestration is proprietary but the layout is fully public. Ref: the OpenMediaVault "HowTo build an SHR – Sliced Hybrid Raid" thread builds the exact stack on plain Linux; slices sized to the NEXT-smallest disk, mdadm per slice-group, leftover regions → extra arrays, LVM concat, btrfs/ext4 on top, RAID always in md never btrfs-native.) Release discipline is the complexity guard; build long, gate hard, ship only when whole.)* *(Promoted 2026-07-18: this is the V2 headline — the Synology-alternative feature, with online expansion as the killer capability given current disk prices. Still sequenced after Epic 16 and behind Epic 11's md basics.)*

### Epic 12: Multi-Node / Cluster Management

> As a user, I can manage storage and shares across multiple Proxmox nodes from a single ANAS instance.

> **Status: OBE 2026-07-18 (operator call).** The epic as written (one central anas instance, anasd over TCP/TLS to remote nodes) was superseded by the architecture V1 actually shipped — the **Ceph model**: per-node install (each node runs its own anas+anasd pair), routed front-end (the gateway forwards `/api/nodes/<node>/...` to that node's anas with the ticket, over cluster-CA TLS), cluster-wide config where it belongs (the pmxcfs remotes registry). Whatever node you connect to works, as long as it has the package — same as PVE's own Ceph panels. No central instance, no new transport. One surviving story:

12.2. [done 2026-07-25 — single-node fail-open proven on the stunt node; multi-node live-proof deferred to the prod cluster (see story note)] As a user, I want ANAS to serve its API at `/anas/*` **through PVE's own `:8006`** (a fail-open reverse-proxy hook in pveproxy → the gateway on loopback), so there's **no separate `:3000` origin, no browser cert exception, no CORS, and the PVE session cookie flows same-origin** — one surface. *(Design: docs/PROXY-TRANSPORT-DESIGN.md; two stunt-node spikes proved feasibility + fail-open. The PVE-side change is one additive block that runtime-requires an ANAS-owned Perl module — a broken/missing ANAS side degrades `/anas` only, never `:8006`; the one hazard (malformed patch) is caught by a `perl -c` gate. Cross-node forwarding retargets to `<node>:8006/anas` with a clean `ANAS_NOT_INSTALLED` signal for nodes lacking ANAS (e.g. Ceph-only). Multi-node live-proof deferred to the prod cluster; single-node fail-open proven on the stunt node. Supersedes the `:3000` public origin + its cert-trust first-run note.)*

12.1. [done 2026-07-18] As a user, I want ANAS to detect **version skew** — between a node's gateway and daemon, between nodes in cross-node routing, and between the browser-cached UI (`anas.js`) and the gateway — and surface a clear warning, so that a partially-upgraded cluster tells me instead of failing strangely. *(Enabled by 10.10: every layer now reports its semver — the shared VERSION const in health/status responses, /opt/anas/VERSION on disk. Warn, don't hard-fail (homelab-friendly); a version column/badge on cross-node views and a mismatch callout is likely enough. Design when scheduled: exact comparison rule — probably warn on any difference, since the API is /v1/ and additive.)* *(Implemented 2026-07-18: gateway stamps `X-Anas-Version` on every response (local always wins over a forwarded peer's copy; CORS-exposed); installer stamps `ANAS.BUILD_VERSION` into the generated anas.js from `/opt/anas/VERSION` (dev trees fall back to package.json; unstampable → checks off); the existing per-view health probe — which already returns the target node's daemon version — compares all three and docks an advisory banner naming the versions, with a reload-vs-upgrade hint depending on where the skew is. Zero extra requests. Verified: unit tests on both header paths, installer stamp in both layouts, and a 7-case decision-table run of the banner logic.)*

### Epic 14: Directory Services / External Identity (enterprise)

> As an enterprise user, I can join the storage host to Active Directory or LDAP so that domain users and groups can own files and access SMB/NFS shares.

> **Deferred 2026-07-18 (operator call): homelab first.** Enterprise identity isn't the current audience; NFSv4 ACLs (4.7.1) stay deferred with it — they only earn their complexity in an AD-managed shop. The Epic 8 getent seam keeps this a drop-in later; nothing else needs to be kept warm for it.

Enterprise identity is nearly a requirement for real deployments — users live in AD/LDAP, not `/etc/passwd`. The key insight: PVE's AD/LDAP *realms* authenticate users to the PVE UI but do NOT make them system-resolvable for file ownership. That needs OS-level domain integration — **`realmd` + `winbind`/`sssd` + nsswitch** — which PVE has no story for. This is a genuine PVE gap and thus differentiated ANAS value.

Per Don't-Build-Undifferentiated-Code: ANAS **configures** realmd/winbind/sssd (join domain, wire nsswitch, map SMB via Samba's AD member mode) — it does not build identity mapping. Once joined, everything else works unchanged *because* user/group resolution goes through `getent` (the Epic 8 seam): pickers, ownership, and ACLs all just see domain users. Pairs with the NFSv4 ACL editor (4.7.1) and SMB (Epic 6, run as an AD member).

Detailed stories to be written when prioritized. Not MVP — but the getent seam (Epic 8) must be in place so this drops in without rework.

### Epic 16: File Backup via Proxmox Backup — **COMPLETE 2026-07-19** (designed, built, and live-proven in one arc)

> As a user, I want ANAS to back up host FILE data — shares, datasets, **and any mounted drive/path** — to a Proxmox Backup Server using `proxmox-backup-client`, so my NAS data gets PBS's dedup/encryption/retention/verification without hand-rolled cron jobs.

> **Scope note (operator, 2026-07-18): NOT scoped to ANAS shares/datasets.** Backup sources are paths, and a mounted non-ZFS drive is a first-class source — that's how the operator's existing cron jobs work. Implication for the source picker: offer datasets/shares as convenient entries, but accept any mounted path (surface `findmnt` mounts as candidates). Snapshot-consistency is a per-source capability, not a requirement: a ZFS-backed source gets the snapshot → backup-from-`.zfs/snapshot` → destroy treatment; a plain mounted filesystem backs up live (stated in the UI, not hidden).

Captured 2026-07-16 from real-world use: the operator currently runs ad-hoc cron
jobs invoking proxmox-backup-client (file/pxar backup of directories to a PBS
datastore) on several nodes. PVE's own backup story (vzdump/PBS) covers GUESTS,
not host file data — so file-level NAS backup is a genuine gap and differentiated
ANAS value, and it is maximal guest-philosophy leverage: PBS owns the hard parts
(chunking, dedup, encryption, retention, verify, restore); ANAS only *configures
and schedules* the client invocation and surfaces status.

> **Design decisions (agreed 2026-07-18 — ground truth: the operator's real `pbc-backup.sh` cron script):**
> - **Task model — multi-archive is a choice, never a requirement.** A backup task = repository ref + PBS namespace + **`backup-id` (the PBS group identity: defaults to the hostname, per-task overridable — the operator's pve10 task uses `--backup-id pictures`)** + **1..N archives**, each `{name, path, excludes[]}` — the operator's own shapes (six named pxar archives in one atomic group; a single-archive task under its own backup-id) both fully supported. Archive **names, paths, and the backup-id are explicit config data** (stable PBS identities, shown in the UI — never derived/hidden). Snapshot-history lookups key on `host/<backup-id>`. **Real-world ids are logical names** (operator's PBS shows `host/pictures`, `host/storage`, `host/torrents`, `host/work` …) — hostname is only the default; and `host/pve14storage` shows the operator encoding the NODE into the id when disambiguation matters, so the UI should suggest `<host>-<task>` on cross-node name collisions.
> - **Client-side encryption is an explicit v1 non-goal** (deliberate, not forgotten): the operator's real groups all show Encrypted: No; the env contract leaves the door open (`PBS_ENCRYPTION_PASSWORD`/keyfiles) for a future story on demand — ANAS does not manage backup encryption keys in v1.
> - **Resource limits — the fd cap (default 1024, per-task overridable) binds pbc via `prlimit` around the daemon's exec.** Operator ground truth (pve10): without the cap, pbc **runs out of file handles because it keeps them open too long — worst in metadata change-detection mode**, suspected interaction with the network stack. The cap is backpressure: forcing early handle release keeps behavior sustainable. *(Revised at live-proof: the original "LimitNOFILE= on the unit, no prlimit wrapper" mechanism was INERT — pbc execs inside anasd (nofile 524288), not in the task unit's cgroup, so the unit limit never reached it. The daemon now wraps the pbc exec in `prlimit --nofile=N:N` — execFile-safe, args as arrays, and exactly the operator's own proven mechanism. The unit keeps `LimitNOFILE=` for the thin helper as defense-in-depth. 16.1's empirical note: fd-hoarding didn't reproduce at 40k-file VM scale, but pbc's metadata-mode low-fd preflight warning confirms the sensitive path.)*
> - **Excludes are explicit config**, per archive, passed as `--exclude` patterns. The tool's `.pxarexclude` dotfile convention keeps working for hand-managed trees (guest philosophy — we never strip it), but ANAS-configured excludes live in the task config where they can be seen and edited.
> - **Repositories = the replication-remotes pattern reapplied**: registered PBS repositories (user@host:port:datastore) in the cluster-wide CAS-versioned store; **certificate fingerprint pinned with explicit one-time confirmation** (the operator's script already pins `PBS_FINGERPRINT` — no silent TOFU); diagnosing test-connection (dns / tcp / tls-fingerprint / auth / datastore / namespace verdicts). `storage.cfg` PBS entries may pre-fill the add dialog (read-only), never be written. The registry is plural from day one — the operator already runs **two distinct PBS targets** (different hosts and datastores). The env-var contract is the control surface the client already speaks (`PBS_HOST/PORT/USERNAME/PASSWORD/DATASTORE/NAMESPACE/FINGERPRINT`, composed `PBS_REPOSITORY`) — ANAS's job is generating that environment safely from the registry + creds files, not inventing a new one.
> - **Auth is a per-repository user choice: API token OR username+password.** UI copy recommends tokens (scoped, revocable) but both are first-class. Secret in a per-repo root-only 0600 file under `/etc/anas/creds/`, injected via environment (`PBS_PASSWORD`) — never argv, never a world-readable script (the one thing the operator's cron script did wrong, per the operator).
> - **`--change-detection-mode` is a per-task choice, not a forced default**: the client's default (data/block) mode vs `metadata`. Honest guidance in the UI — metadata re-scans many-small-file trees faster; the operator's field experience is that default mode holds up well, especially for big backups. No pretending one is universally optimal.
> - **Snapshot-consistency is a per-source upgrade**: ZFS-backed paths get snapshot → back up from `.zfs/snapshot` → destroy (atomicity for free); non-ZFS paths back up live, labeled as such (the operator's baseline for years). Mounted drives are first-class sources (scope note above); the Epic 18 mount inventory feeds the picker.
> - **Run-Now goes through the task's own systemd unit** (`systemctl start`, the daemon job supervising to completion) so manual runs land in systemd last-result and the unit's journal exactly like scheduled ones — one code path, one history. *(Revised 2026-07-19 after pve5 testing: the original run-inside-the-daemon approach traded history for live progress, but progress was already end-of-run coarse — the trade bought nothing and manual runs were invisible in the grid and detail.)*
> - **Scheduling/status = the replication template, with one operator ruling on top: ANAS NEVER contacts the PBS server for status/monitoring.** (The sole server contacts are the backup runs themselves, the explicit user-initiated repository Test, and the task wizard's SAVE-TIME namespace verification — operator-sanctioned 2026-07-19 after pve5 testing showed a task could target a namespace that doesn't exist and fail only at first run; it reuses the test endpoint, user-initiated and one-shot, warn-not-block. Never polling, never background.) `anas-backup-<name>.service`/`.timer` ARE the task store (no second config source); the service invokes the helper that POSTs the daemon job, exiting truthfully for systemd. Status is LOCAL-ONLY: last result/next run/overdue from persistent systemd unit+timer state (survives restarts), recent run detail from journald (labeled forensics — it rotates, so older history may simply be unavailable, same accepted trade as the jobs system), live progress from the job. Server-side truth (snapshot history, counts, sizes, verify state) belongs to the PBS UI — ANAS points there, never rebuilds or polls it. Retention/prune/GC likewise PBS-side, not surfaced. *(**Retention REVISITED 2026-08-17 — see 16.11.** The ruling held for status; it did not survive contact with reality for retention: PVE itself prunes per backup job, and the operator's own PVE storage entries all carry `keep-all=1`, so nothing prunes today. A task may now carry an OPTIONAL retention policy that ANAS applies with `proxmox-backup-client prune` after a successful run. **GC stays PBS-side, untouched**, and the never-poll rule is unchanged — the sanctioned contact list grows by exactly the post-backup prune and a user-initiated dry-run preview.)*
> - **Restore points at the PBS UI** (leverage); a restore browser is a someday, not v1.
> - **Scope guard stands**: file/pxar only, no guest backups (PVE owns those), no PBS server management.

#### Stories

##### Dev (ground truth first)
16.1. [done 2026-07-18] As a dev, I want ground truth from a real PBS target before code: stand up a disposable PBS (test VM or PBS packages on the stunt node — NEVER the operator's real PBS box), then capture verbatim: successful backup runs (both change-detection modes, multi-archive, excludes), the full failure taxonomy (bad fingerprint / bad token / bad password / missing datastore / bad namespace / unreachable) with exit codes and stderr, and the exact env-var contract (`PBS_REPOSITORY`/`PBS_PASSWORD`/`PBS_FINGERPRINT`, token id syntax) — so the parser, verdicts, and creds handling are built on reality. *(Also: reproduce the operator's `prlimit --nofile=1024:1024` motivation — run a large backup with default systemd nofile limits and observe what degrades/breaks; capture `--backup-id` behavior incl. group naming in `snapshot list` output.)*

16.2. [done 2026-07-19 — live-proven: CAS 409s, creds 0600 never in registry/journald, rotation, IN_USE delete refusal] As a dev, I want the PBS repositories registry + shared schemas: cluster-wide CAS-versioned store (the replication-remotes machinery), per-repo secret files (0600, write-only through the API, token or password), fingerprint pinning with confirm-once, and a diagnosing test endpoint — so repositories are registered once and usable cluster-wide.

16.3. [done 2026-07-19 — live-proven: units carry X-ANAS-Task + LimitNOFILE, timer→helper→/run end-to-end, systemd last-result truthful] As a dev, I want backup tasks stored as systemd units (`anas-backup-<name>.service` + `.timer`, generated/parsed/rewritten like replication's) carrying the full task config (repository ref, namespace, archives with excludes, change-detection mode), so there is no second config source and systemd's own state stays truthful.

##### Observe
16.4. [done 2026-07-19 — live-proven; detail keeps the raw journal blob: live journalctl parsing judged not a trivial safe win, structured recentRuns[] deferred] As a user, I want a **Backup** menu: task grid (name, repository:datastore/namespace, archive count, last run + result, next run, overdue highlighted) with per-task detail showing the archive list, the configured unit/timer as written, and recent run output from journald (labeled as recent-only forensics — older history ages out, accepted) — so backup health is observable in one place **without ANAS ever contacting the PBS server** (operator ruling: all status from jobs + the journal + persistent systemd state; the PBS UI owns server-side history/verify — the detail links there rather than rebuilding it).

##### Act
16.5. [done 2026-07-19 — live-proven: multi-archive+excludes verified server-side via catalog dump, both modes, benign too-soon skip, owner-mismatch clear message, fd cap via prlimit (see revised resource-limits bullet)] As a user, I want to create/edit/disable/delete backup tasks — pick a repository + namespace, add 1..N archives (name, path from the free-typed path or the datasets/shares/mounts pickers, per-archive excludes), choose schedule and change-detection mode, Run Now with job progress — so my hand-rolled cron jobs become managed, observable tasks. *(Suggested-defaults nicety: offer an `etc.pxar:/etc` host-config archive in the new-task dialog — the operator's own habit worth spreading.)*

16.6. [done 2026-07-19 — live-proven: every test verdict incl. byte-exact fingerprint retrieval; note: bad-datastore folds into auth for scoped tokens (PBS checks ACL before existence — real server behavior)] As a user, I want the repositories manager UI: add/edit a PBS repository with the auth choice (token recommended, username+password supported), the fingerprint shown for explicit confirmation, and Test that diagnoses rather than fails — so targets are set up once, safely.

##### Dashboard
16.7. [done 2026-07-19 — live-proven: forced failure → backup warning, disable clears it; overdue fires only as post-downtime catch-up (systemd keeps NextElapse in the future on a healthy node) — accepted semantics] As a user, I want only failures and overdue tasks surfaced (new `backup` warning category, replication policy: silently-overdue-past-interval counts as failed; healthy/idle shows nothing) — and this epic further strengthens the deferred 9.4 notification evaluation once shipped.

16.8. [done 2026-07-19 — live-proven registering nothing: PVE entry appears as `pve:<id>` badged + hands-off (PVE_MANAGED 400 on mutations), test ok, task targeted it, snapshot landed server-side, rotation via pvesm picked up fresh (read-at-exec), secret absent from creds/registry/argv/journald. Collision rule: the `pve:` prefix is unreachable by tier-2 names (colon is not a legal BackupName char). Defect caught in proof: the runner dropped the repo's own namespace — effective ns is now task's ?? repo's, matching the test path.] As a user, I want ANAS to **piggyback on PVE's PBS storages for credentials** — every `pbs` entry in `storage.cfg` appears as an auto-discovered, PVE-badged repository (server/datastore/username/fingerprint from the read-only parse; the secret read from `/etc/pve/priv/storage/<id>.pw` AT EXEC/TEST TIME, never copied or cached) usable as a task target but never editable/deletable through ANAS — so a PBS target I already gave PVE needs zero re-entry. *(Operator insight 2026-07-19: "when I back up VMs I don't define anything beyond the repo storage." The replication two-tier model reapplied: PVE-defined = tier 1 zero-config, ANAS-registered = tier 2 for targets PVE doesn't know. pmxcfs replicates both the stanza and the secret cluster-wide, and rotation in PVE is instantly effective since ANAS holds no second copy. Ground truth first: capture a real `pvesm add pbs` stanza incl. namespace/port/token-id syntax on the stunt node against the test PBS.)*

16.9. [done 2026-07-20 — proven on pve5; operator verdict: the Details-window layout is better. KNOWN ISSUE: the v1 directory picker (flat listbox navigator) "doesn't come up to desktop picker level of usability — the flat layout can confuse more than help" (operator, 2026-07-20). Replace in a later pass with something genuinely desktop-grade — candidates: an expanding tree (PVE's own idiom), breadcrumb bar + type-ahead — the /v1/fs/browse endpoint already supports any of these. Free-form typing remains primary meanwhile.] As a user, I want the Backup screen refined from real use (operator feedback 2026-07-20, after the first successful scheduled run): the always-docked detail area moves behind a **Details button** (grid gets the full height); archive paths get a **directory picker** (the new `GET /v1/fs/browse` — free-form typing stays first-class); and Save performs **gentle path validation** — missing archive paths listed in a warn-not-block confirm, the namespace-check pattern — so the common mistakes surface at creation without ever getting in the way.

##### Cadence & retention (added 2026-08-17)
16.10. [done 2026-08-17 — live-proven on stunt same day: real doctored-timer off-week fire exited 75/systemd-success, grid lastRunResult=skipped, not overdue, journal off-week line; Run Now bypassed the gate; generated `Mon 02:00` validated] As a user, I want a backup task's schedule expressed as a **cadence** — weekly on one or more weekdays, **every other week** on one weekday, or monthly on a weekday's first occurrence, each at a chosen time — with the raw OnCalendar field still there as `custom`, so the biweekly cron jobs I run today become managed ANAS tasks without losing their phase. *(Operator context: six real PBS cron jobs run on a strict biweekly cadence — ISO-week parity, staggered weekdays at 02:00 — and migrating them is the first ground truth Epic 16 gets from the field. Decisions, all operator-final: **parity is EXPLICIT config (`even`/`odd`), never derived from a creation date**, because those six jobs stagger their phases deliberately and the migration must be able to state the phase it wants. **ANAS adds logic only where OnCalendar cannot express the schedule**: weekly/monthly/custom are pure OnCalendar with `Persistent=true` as their missed-run heal, and only **biweekly** gets a gate — a WEEKLY timer plus an ISO-week parity check (`date +%V` semantics, read from the LOCAL calendar date so a 02:00 fire lands in the week the operator sees) in the daemon's run path. An off-week fire completes as a **distinct, visible "skipped (off week)"** — a journal line, a `skipped` task status, and never a fake success-with-backup or a failure. **Heal rule:** run regardless of parity when the last SUCCESSFUL run is older than 14 days (one full period) — which also covers an on-week run that FAILED rather than merely missed; because parity is fixed config a heal produces at most one shortened 7-day interval and then re-locks to the configured phase, so the **phase never flips**. With no last-success record (fresh task, rotated journal) it RUNS: a redundant backup is safe, a missed one is not. **Run Now bypasses the gate** — user-initiated is explicit intent; only scheduled fires are gated. **Overdue is cadence-aware** (16.7 measured against the real period, not the weekly timer), so a healthy off-week skip never reads overdue.)* *(Implemented 2026-08-17: shared `BackupCadence` + `cadenceToOnCalendar` — the generator lives ONCE, and `BackupTaskRequest` derives `schedule` from a cadence so the UI never reimplements systemd calendar syntax; generated expressions are validated with `systemd-analyze calendar` exactly like typed ones. `services/backup-cadence.ts` holds the pure run-time logic (ISO week, gate, overdue window; `now` always injected). Two mechanisms worth knowing: (1) the runner exits with `BACKUP_SKIP_EXIT_CODE=75` on a gated fire and the unit declares `SuccessExitStatus=75`, so systemd records SUCCESS while `ExecMainStatus` still says no backup was taken — the skip is derivable from the same `systemctl show` the grid already makes, with no extra journald read and no state file (stateless). (2) **The `direct` flag does NOT identify a scheduled fire** — a UI Run-Now goes through the task's own unit (16.5 Fix 1), so both arrive as `direct:true`; the trigger is instead read from systemd's own truth, the timer's `LastTriggerUSec` versus the service's `InactiveExitTimestamp`, failing open to 'manual' (gate open) when unknowable. Last-success for the heal comes from the unit journal (LOCAL-ONLY — the PBS server is never asked), read only when the decision can still turn on it. UI: a Schedule fieldset with a kind radiogroup, weekday multi-select / single weekday + even-odd parity / raw OnCalendar, read straight off the fields by itemId — no hiddenfield mirroring, per issue #26.)*

16.11. **[done 2026-08-17 — live-proven on stunt same day: real post-success prune removed=1/kept=2 with keepLast=2 on the third run, dry-run preview ok, and an off-week SKIP pruned nothing (group count unchanged)]** As a user, I want an **optional per-task retention policy** — `{keepLast, keepDaily, keepWeekly, keepMonthly, keepYearly}`, any subset, positive ints — so my backup groups stop growing forever without me hand-running prune. *(**Explicit REVISIT of the "retention is PBS-side only" ruling** (operator, 2026-08-17): PVE itself prunes per backup job, and the operator's PVE storage entries all carry `keep-all=1` — i.e. **nothing prunes today**. Semantics, all FINAL: **absent policy = ANAS never invokes prune** (today's behavior; a keep-flag-less prune is a server-side keep-all no-op, and we do not even run it); after a **SUCCESSFUL** run the same job runs `proxmox-backup-client prune host/<backup-id> [--ns] --keep-* … --output-format json` with exactly the configured flags, parses the **JSON** (never the human table — Principle 13) and surfaces kept/removed/protected in the job result and a journal line; a **prune failure NEVER fails the job** — the backup data is safe, so the job completes carrying `warnings[]` (vzdump's own posture); a FAILED backup and a skip (the benign too-soon collision, and a cadence off-week skip) never prune; **Run Now prunes too** — prune belongs to the task's flow, not the timer's; **GC stays PBS-side**, never surfaced or triggered. A user-initiated `POST /v1/backup/tasks/:name/prune-preview` dry run (the save-time namespace-verify precedent reapplied — one-shot, non-mutating, body may carry an unsaved task inline) backs the wizard's Preview button. This widens the sanctioned PBS-contact list by exactly those two calls; **the never-poll rule is untouched**.)* — **Ground truth first** (fixtures `packages/daemon/src/fixtures/backup/prune-*.txt` + NOTES §8, captured 2026-08-17 on the stunt PBS 4.2.3): `--output-format json` returns `{backup-id, backup-time (unix s), backup-type, keep, ns, protected}` and **dry-run and real prune emit the SAME shape**; a **missing group and a missing namespace are INDISTINGUISHABLE** (both `ENOENT`, exit 255) so the verdict says "group or namespace" and never guesses; a missing privilege is `permission check failed - missing Datastore.Modify|Datastore.Prune`; prune is idempotent and only MARKS. Capture traps recorded: `datastore remove` **purges the path's ACLs**, and **PBS refuses any backup older than a group's latest snapshot** (no backfill — synthetic history must be built oldest-first). — **Built:** shared `BackupRetention`/`BackupPrune*` schemas + `hasRetentionKeeps` (the one gate), `services/backup-prune.ts` (argv, JSON parser, counts, verdicts, `pruneAfterBackup`), the run job's post-success step and the preview route, retention through the unit round-trip (units ARE the store) and the helper→supervisor result path, and the wizard's Retention fieldset with a Preview button + a detail-view summary. 32 new tests.

### Epic 17: Scheduled Snapshots & Scrubs

> As a user, I can schedule automatic snapshots with retention policies and recurring pool scrubs, and manage both from one dedicated screen — so routine data protection runs unattended.

> **Inked 2026-07-18 (operator call): its own epic because it needs a new screen.** One new top-level menu item (per the one-menu-per-feature rule) covering both task types — the Replication view is the idiom to follow (task grid: target, policy/cadence, last run, next run, overdue). The standing scheduling ruling applies in full: **leverage `sanoid`/`zfsutils` scrub timers/systemd — never build a scheduler.** Closes the biggest remaining TrueNAS-parity gap (Periodic Snapshot Tasks).

#### Stories

> **DESIGN SUPERSEDED 2026-07-26 (docs/SCHEDULES-DESIGN.md).** After the operator required snapshot scheduling **uniform across AHR (btrfs) and ZFS**, the 17.1 `sanoid` tool pick was dropped — sanoid is ZFS-only and cannot deliver uniformity, and nothing it does that we'd use is irreplaceable (keep-N retention is a simple algorithm; monitoring/syncoid unused; its hold-handling is worse than ours). ANAS now **manages the schedule itself**: one **systemd timer** per schedule (Persistent=true catches missed runs; no scheduler built) + a keep-N retention engine (learned from sanoid's bucketing) driving `zfs snapshot`/destroy for ZFS and the 11.12 btrfs snapshot primitives for AHR — one policy, one screen, uniform. Scrub scheduling stays per-filesystem-native (ZFS = PVE's `org.debian:periodic-scrub` cron property; AHR/md = mdcheck timers), surfaced + toggled. 17.1 ground truth stays valid (only its tool decision is superseded); 17.2's sanoid.conf parser is superseded (dead product code, removed at build). Stories below are re-based onto the ANAS-owned mechanism.

##### Dev (ground truth + tool decision first)
17.1. **[done 2026-07-26]** As a dev, I want ground truth captured from a real node before any parser is written — sanoid's config format and pruning behavior, `zfsutils-linux`'s shipped scrub machinery (`zfs-scrub-monthly@.timer` templates and/or the cron.d entry PVE nodes actually carry), and what a stock PVE node already scrubs by default — so the tool decision (sanoid vs `zfs-auto-snapshot`) and the config surface are based on reality, not docs. *(Per the ground-truth-first rule. sanoid is the presumptive pick — retention policies are its core competency — but confirm packaging/behavior on PVE first.)* — **Result: tool = `sanoid 2.2.0-2` (Debian 13 main; timer-driven, template retention model, config-is-the-API).** Key GT (docs/SCHEDULES-GROUND-TRUTH.md, fixtures in packages/daemon/src/fixtures/schedules/): PVE already auto-scrubs every pool monthly via `/etc/cron.d/zfsutils-linux` gated by the `org.debian:periodic-scrub` ZFS property (default `-`/auto = scrub) — systemd `zfs-scrub-*@.timer` exist but are disabled (17.5 must not double-schedule). sanoid = `/etc/sanoid/sanoid.conf` INI (templates + `[pool/dataset]` stanzas + `use_template`), driven by a 15-min `sanoid.timer` → take + prune oneshots (no scheduler built). Holds-vs-prune OBSERVED: sanoid tries to destroy held snapshots, ZFS refuses, sanoid `warn`s non-fatally (exit 0) and the held snap survives — retried every run, so 17.6 must surface held-and-skipped from ZFS `userrefs`/`zfs holds`. Parser gotcha: sanoid is STRICT — unknown key = FATAL (exit 255); whitelist = the shipped `sanoid.defaults.conf`.

17.2. **[done 2026-07-26]** As a dev, I want a round-trip parser for the chosen tool's config (presumably `sanoid.conf` INI: templates + per-dataset stanzas) preserving comments/ordering/unknown directives, so schedule management is surgical config editing like smb.conf/exports. *(Config files are the API.)* — **Result:** `packages/daemon/src/parsers/sanoid-conf.ts` — a byte-fidelity document model (stanza overlay on the original line array; `serializeSanoidDoc(parseSanoidDoc(t)) === t` for any input incl. tabs/comments/ordering/the unknown-directive fixture) with a typed read-model (`parseSanoidConf` → version + templates[] + datasets[]) layered on top, mirroring smb-conf/fstab. Effective-policy resolution (GT-8) through shipped-defaults → local `[template_default]` → `use_template` chain (listed order, **later wins**) → inline overrides. Whitelist sourced from the shipped `sanoid.defaults.conf` `[template_default]` (never a hand-list): unknown keys **preserved on read** + surfaced via `findUnrecognizedKeys`, **refused on write** via `SanoidUnknownKeyError` (GT-9). Surgical editors (`setSetting`/`addDataset`/`addTemplate`/`removeDataset`/`removeTemplate`) touch only the target lines. Shared Zod: `Sanoid{Config,Template,Dataset,Retention,EffectivePolicy,Settings,Recursive,UnknownSetting}`. 26 tests against the real fixtures; suite 1159 daemon + 34 gateway green; typecheck + lint clean.

> **Stage 2 landed 2026-07-26 (backend, no UI).** The uniform schedule STORE +
> systemd timers + scrub toggle + routes + dashboard warnings are built and
> live-proven on the stunt node (SCHEDULES-GROUND-TRUTH.md §Stage 2, GT-10..15):
> `services/snapshot-schedule-units.ts` (units-as-store, cadence→OnCalendar,
> status derivation, 17.7 warnings), `services/scrub-schedules.ts` (ZFS property +
> mdcheck toggle), `services/systemd-status.ts` (shared unit-status helpers),
> `snapshot-task.ts` (timer runner), `routes/schedules.ts` (CRUD + fire),
> `routes/scrub.ts` (uniform state + per-fs toggle). The **Schedules SCREEN
> (17.3) and create/edit UI (17.4) are stage 3** — deferred.

> **Stage 3 landed 2026-07-26 (UI).** The native-ExtJS **Schedules** screen ships:
> `packages/pve-integration/src/69-schedules.js` — one uniform grid over ZFS and
> AHR snapshot schedules (Name/id, Target, Cadence, Retention summary, Last run,
> Next run w/ overdue chip, Enabled) + Create/Edit/Enable-Disable/Delete/Run-Now;
> the create/edit dialog's uniform target picker (ZFS dataset OR AHR pool, ANAS-
> managed only), retention **presets** + an **advanced** per-bucket keep-N
> expander, `recursive` (ZFS); and a collapsible **Periodic scrub** panel — the
> uniform on/off toggle with the mdcheck **node-global** note surfaced per-row and
> confirmed on toggle. Menu-registered (90-register) between Replication and
> Backup; the `schedule` dashboard-warning icon added (17.7 card render). Full
> lifecycle live-proven on the stunt node via the real API (create→edit→run→take
> real ZFS snapshot→toggle→delete; ZFS per-pool scrub toggle round-trip).

> **Stage 4 landed 2026-07-27 (operator refinement, UI).** After reviewing the
> Stage-3 screen the operator asked for two things: (1) **split** the single
> Schedules screen into two menu entries, and (2) surface the **last-run logs +
> exit status** of a snapshot schedule. Done:
> - `69-schedules.js` split into `69-snapshots.js` (**Snapshots** menu — the
>   snapshot-schedule grid + Create/Edit/Enable-Disable/Delete/Run-Now/**View log**
>   + the create/edit dialog) and `69-scrubs.js` (**Scrubs** menu — the periodic-
>   scrub grid + toggle + node-global mdcheck caveat). ORDER now `…replication,
>   snapshots, scrubs, backup…`; the dead `schedules` view removed. The bits both
>   views share (fs-tag chip, state pills, the visibility-gated poll loop) live
>   ONCE in `69-schedules-common.js` (`ANAS.sched.*`) — no diverging second copy.
> - **Last-run log + exit status** MIRRORS the backup task detail (parallel
>   construction): `GET /v1/schedules/:id` now returns a **detail** —
>   `lastRunExitCode` (systemd `ExecMainStatus`), the `.service`/`.timer` verbatim,
>   and a bounded recent **`journal`** blob (`journalctl -u anas-snap-<id>.service
>   -n 200 -o short-iso --no-pager`, same args/handling as backup's
>   `readRecentJournal`). Shared schema `SnapshotScheduleDetail` mirrors
>   `BackupTaskDetail`. A **View log** toolbar button opens an on-demand detail
>   window (fetch-on-open + Reload, no polling) rendering the exit status
>   (success/failure + the numeric exit code, labeled) and the journald `<pre>`
>   with the same "older history is not retained" caveat as the backup detail.
> - Live-proven on the stunt node via the real API on a throwaway file-backed ZFS
>   pool: create→fire the service (timer's own path)→detail shows `journal` +
>   `lastRunExitCode:0`/`success`; forced failure (target destroyed) →
>   `lastRunExitCode:1`/`failure` with the failure in `journal`; Run-Now took a
>   real snapshot; ZFS scrub toggle round-trip; delete→units gone. Daemon suite
>   1206 (+1), gateway 34; typecheck + lint clean; every changed pve-integration
>   file `node --check`-clean.

> **Stage 5 landed 2026-08-17 (operator-approved feature — last scrub + verdict).**
> The Scrubs screen said whether a pool *would* be scrubbed but never whether one
> *had* been. It now carries a **Last scrub** column, completing 17.3's
> "authoritative state from … `zpool status` scrub dates":
> - **ZFS — nearly free, no new source.** `zpool status -jv`'s `scan_stats` is the
>   same record `parseScanStats` already reads for in-progress state; once a pass
>   ends, that record IS the verdict ZFS prints as `scrub repaired 0B in 05:23:11
>   with 0 errors on …`. New `lastScrubFromScan` / `parseLastScrubs`
>   (`parsers/zpool-status.ts`) interpret the finished form — pass type, outcome,
>   end date, duration (end − start), repaired bytes (ZFS's `processed`), errors —
>   into shared `LastScrub`, carried on every `PeriodicScrubState` from
>   `GET /v1/scrub` (one status read serves every pool). The screen says it in
>   words: "repaired 0 B, 0 errors — 2026-08-03 07:23 (took 5h 23m)", warn-coloured
>   when anything was repaired or any error found. A **canceled** pass reads
>   "canceled — <date>" (it verified only PART of the pool, so its 0 errors is
>   never shown as a clean bill of health); a **resilver** is named as a resilver
>   (ZFS keeps one scan record per pool, not one of each).
> - **AHR — honest absence, the SANCTIONED DIVERGENCE.** md keeps no completion
>   record at all, so an AHR row's `lastScrub` is always null and the cell says
>   "— (md keeps no completion record)" instead of sitting blank. Explicitly NOT
>   built: journald archaeology, and any ANAS-written state file (stateless,
>   Principle 11 — we report what the system records and nothing else).
> - Tests cover every scan-record form: finished clean scrub, finished scrub that
>   repaired bytes and found errors, canceled scrub, finished resilver, in-progress
>   (no verdict yet), "none requested", and an unrecorded start time — plus the
>   route carrying the verdict and still answering when the status read fails. New
>   fixture `fixtures/zfs/zpool-status-scrub-verdicts.json` holds the two forms no
>   node capture has (repairs/errors, cancel), flagged in its own `_comment` as
>   **canonical forms, not node captures**. `ANAS.sched.absTime` extracted to
>   `69-schedules-common.js` so both schedule views print timestamps from one copy.
>   Daemon suite 1477 (+11), gateway 46; typecheck + lint clean; changed
>   pve-integration files `node --check`-clean. **Not yet reviewed on a node.**

##### Observe
17.3. **[done 2026-07-26, stage 3 — screen shipped]** As a user, I want the **Schedules** screen: one grid over both snapshot schedules and scrub schedules — target (dataset/pool, recursive flag), policy summary (e.g. "24h / 30d / 12m" or "monthly scrub"), enabled state, last run/result, next run, and overdue highlighted — including schedules created outside ANAS, so I have the complete picture. *(Authoritative state from the config file + systemd timer state + ZFS reality (`zfs list -t snapshot` counts, `zpool status` scrub dates); journald is run-detail forensics only, per the replication precedent.)* — **Backend:** `GET /v1/schedules` returns the uniform derived-status rows (systemd next/last/result/overdue); `GET /v1/scrub` the uniform periodic-scrub state across ZFS + AHR pools.

##### Act
17.4. **[done 2026-07-26, stage 3 — create/edit UI shipped]** As a user, I want to create/edit/disable/delete a snapshot schedule with a retention policy (keep N hourly/daily/weekly/monthly, recursive or not) on a dataset or pool root, so snapshots manage themselves. *(Surgical edit of the tool's config; the tool's own timer does the running.)* — **Backend:** `POST/PUT/DELETE /v1/schedules[/:id]` write/rewrite/remove the `anas-snap-<id>.{service,timer}` pair (units-as-store, `Persistent=true`); `POST /v1/schedules/:id/run` fires take+prune (the timer's own path). Live-proven: create→fire→prune→held-safety→delete (GT-11..13).

17.5. **[done 2026-07-26, stage 3 — scrub surfacing UI shipped]** As a user, I want per-pool scrub schedules (weekly/monthly/custom), with ANAS recognizing and surfacing the distro/PVE default scrub rather than double-scheduling it, so pools verify themselves without me remembering. *(systemd timer units per the replication task-store pattern; guest philosophy — the existing default is surfaced and adjusted, not fought.)* — **Backend:** ZFS = surface+toggle `org.debian:periodic-scrub` (never touches the disabled `zfs-scrub-*@.timer`, so no double-schedule); AHR = surface+toggle mdadm's `mdcheck_start/continue` timers (NODE-GLOBAL — surfaced via a state `note`). `GET /v1/scrub`, `PUT /v1/scrub/{zfs,ahr}/:pool`. Custom cadence beyond native monthly deferred (SCHEDULES-DESIGN §Scrub). Round-trip live-proven (GT-14/15).

##### Safety
17.6. **[done 2026-07-26, stage 2]** As a user, I want retention pruning to respect `zfs hold`s — replication's incremental bases must never be pruned out from under a chain — with skipped-by-hold snapshots surfaced (not silently retried forever), so snapshot cleanup and replication coexist. *(The known holds-vs-cleanup trap; whatever pruning tool wins 17.1 must be verified against held snapshots as part of live-proof.)* — **Result:** the retention engine excludes held snapshots up front and prune re-checks `userrefs` immediately before each destroy; held ones are surfaced in `skippedHeld`, never destroyed. Live-proven with a real `zfs hold` under `daily=1` — the held base survived (GT-13). Stronger than sanoid's try-and-warn (GT-7): we skip-and-surface.

##### Dashboard
17.7. **[done 2026-07-26, stage 3 — card render shipped]** As a user, I want only failures and overdue schedules on the dashboard (warning card, existing categories) — healthy/idle shows nothing, matching the replication policy. *(This epic multiplies the unattended tasks in the system — it strengthens the case for the deferred 9.4 notification evaluation once shipped.)* — **Backend:** `buildScheduleWarnings`/`collectScheduleWarnings` (new `schedule` DashboardWarning category) wired into `GET /v1/status`; warns ONLY on enabled failed/overdue schedules — disabled and healthy contribute nothing, errors fail-open.

### Epic 18: Mounts — External & Local Storage

> As a user, I can mount external and local storage — spare disks, USB drives, and remote NFS/CIFS shares — and have it usable as NAS data (shareable, backupable), so ANAS covers the storage that isn't ZFS.

> **Status: COMPLETE (as descoped) 2026-07-18.** The remote-share slice (18.1/18.2/18.3/18.5 + the verb ladder) shipped and live-proven the same day. **18.4/18.6/18.7 descoped by operator ruling: "We're not building a layer over standard Linux, we're building a NAS layer."** Local drives' path is ZFS (later md/SHR, Epic 11); single and removable drives are not ANAS's problem. Enforced in code, not just docs: `MountType` is nfs|cifs only, the daemon 400-rejects mutations on local filesystems (`rejectIfNotRemote`), and the UI shows local mounts observe-only. The inventory still lists local/ZFS/PVE mounts — observing everything remains valuable (Epic 16's source picker) — ANAS just doesn't manage them.
>
> **Inked 2026-07-18 (operator call). Scope boundary stated up front: PVE's artifact-store paradigm is EXCLUDED.** PVE mounts storage (`storage.cfg` dir/NFS/CIFS entries under `/mnt/pve/*`) as content-typed homes for its own artifacts (VM images, ISOs, backups). ANAS does not manage, replicate, or offer that paradigm — **no content types, no storage.cfg writes, ever**. `storage.cfg` is parsed READ-ONLY to tag PVE-owned mounts hands-off (the proven 3.25 pattern). An ANAS mount is a plain filesystem at a path — data the user shares, backs up, or copies.
>
> **Sequencing:** the observe half (18.1–18.3) lands with or before Epic 16 — its backup-source picker wants the mount inventory. The act half lands whenever. Epic 11 (md) then inherits this whole layer: fstab machinery, mount lifecycle, and the Mounts view are its bottom stratum, pulled forward. Mounted paths feed the existing seams for free: shares (Epics 6/7 — a path is a path) and Epic 16 backup sources/targets.

#### Stories

##### Dev (ground truth first)
18.1. [done 2026-07-18] As a dev, I want ground truth captured from real nodes before code: `findmnt`/`lsblk` JSON output shapes, real fstab variants (including hand-edited ones), `storage.cfg` mount entries and where PVE actually mounts them, and the systemd fstab-generator behavior that matters (`nofail`, `x-systemd.automount`, boot ordering) — so the inventory and the persistence model are built on reality.

18.2. [done 2026-07-18 — live-proven; incl. the `#ANAS ` disable marker] As a dev, I want a round-trip fstab parser (parse → modify → write) preserving comments, ordering, and unknown entries, so mount persistence is surgical config editing like smb.conf/exports. *(Config files are the API; the systemd fstab generator does the actual mounting — no mount-manager daemon logic.)*

##### Observe
18.3. [done 2026-07-18 — live-proven on the stunt node: inventory truth, PVE tagging + 400-rejected mutations, capacity, state pills] As a user, I want a **Mounts** view: every mounted filesystem (device, type, mountpoint, size/used, source: local disk / USB / NFS / CIFS), whether it persists in fstab, **PVE-owned mounts tagged hands-off** (from the read-only `storage.cfg` parse — visible for the complete picture, untouchable), and unmounted-but-mountable candidates (partitions carrying a filesystem that aren't claimed by ZFS, md, or PVE) — so I see everything attachable at a glance.

##### Act
18.4. [OBE 2026-07-18 — operator ruling] As a user, I want to mount/unmount a local filesystem (ext4/xfs first-class; ntfs/exfat read-tolerant for data import), with optional fstab persistence defaulting to `nofail` so an absent drive never blocks boot, so spare and external disks become usable storage in two clicks. *(Descoped: single local drives aren't ANAS's niche — the local-drive path is ZFS (later SHR). Local mounts are observe-only inventory; the daemon rejects mutations on them. The "unmounted-but-mountable candidates" clause in 18.3 is descoped with this story.)*

18.5. [done 2026-07-18 — live-proven end-to-end on the stunt node: NFS+CIFS lifecycles, creds never in fstab/ps/journald, the full verb ladder INCLUDING a reboot (disabled stayed down, enabled remounted), busy-unmount 409 + confirm retry, all test verdicts, dead-server → unreachable in ~2s → dashboard mount warning → recovery, and /etc/fstab byte-identical to pre-ANAS baseline after full lifecycle. Live-proof caught 2 real defects, fixed: the executor collapsed async exit codes to 1 (err.status vs err.code — lost timeout's 124, latently daemon-wide) and the binfmt_misc autofs placeholder leaked into the inventory as a spurious 'armed' row. Open design nit: DELETE leaves the empty /mnt/<name> dir behind (matches plain umount semantics; decide deliberately.)] As a user, I want to mount remote NFS and CIFS shares as a client (the old-NAS migration path, and remote backup targets), with CIFS credentials in a root-only credentials file — never inline in fstab, never on argv — so remote data is reachable without hand-editing anything.

> **Remote-mount design decisions (agreed 2026-07-18):**
> - **Pure management** (operator's framing): ANAS writes fstab and calls `mount`/`umount`; kernel + `mount.nfs`/`mount.cifs` + systemd's fstab generator do the work. No mount daemon, no shadow state: configured = the fstab line, actual = `findmnt`, health = a guarded probe. The UI shows the exact fstab line before writing it.
> - **API**: `/v1/mounts` keyed by URL-encoded mountpoint (NFS-exports precedent) — see DESIGN.md for the table. `POST /v1/mounts/test` DIAGNOSES before commit (replication-remotes pattern): DNS → port 2049/445 → short-lived `timeout`-guarded probe mount into a private temp dir → distinct unreachable / auth-failed / not-found / protocol-mismatch / OK verdicts. `showmount -e` export picker where it answers, silent degrade to manual entry.
> - **Options = structured tiers + escape hatch.** Known options in the shared Zod schema (common: ro/rw, `nofail` FORCED, noauto, `x-systemd.automount`+idle-timeout as a toggle, noatime, `nosuid,nodev` default-on for remote; NFS: vers=4.2 default, hard default with soft-corruption warning, timeo/retrans, rsize/wsize; CIFS: vers=3.1.1 default with 1.0 behind a loud warning, domain, and uid/gid/file_mode/dir_mode presented as owner/group pickers off the Epic 8 identity lists — CIFS has no Unix ownership of its own). Everything unrecognized round-trips VERBATIM in a passthrough field — hand-edited entries keep their exotica.
> - **Credentials (operator decision): local `/etc/anas/creds/`, per-mount 0600 root-only files** — mounts are per-node artifacts and boot-time mounting must not depend on pmxcfs (the cluster-store option was considered and rejected for the boot-order coupling). Written by the daemon from the request body (never argv, never inline in fstab); **write-only through the API** — detail returns username/domain + "credentials set", never the secret; rotate via PUT; removed with the mount. NFS is `sec=sys` in v1; Kerberos deferred to the Epic 14 world.
> - **Default mode (operator decision): boot mount with `nofail`** — predictable state, absent server never blocks boot; automount stays a per-mount toggle for flaky links.
> - **The hang trap is the status design center**: a dead NFS server hangs naive `stat()` forever, so the daemon NEVER touches a mountpoint synchronously — liveness/capacity via `timeout 2 stat -f` (execFile) → ok / stale / unreachable / unmounted; systemd unit state for persisted mounts; journald as labeled forensics. Dashboard: new `mount` warning category, failures/stale only.
> - **Safety**: mountpoint must be an empty dir (non-empty → confirm, it shadows); never under `/mnt/pve` or PVE territory; unmount cross-checks shares (6/7) and backup tasks (16) riding the path; busy unmount → 409 with the holding-process list, force/lazy behind the gate.
> - **The verb ladder (agreed 2026-07-18)**: *unmount* = kernel state now, returns at boot; *disable* = the fstab line commented as `#ANAS <original verbatim>` — survives reboot as off, credentials kept, re-enable strips the marker for a byte-identical restore (operator's design: the marker tells both the parser and a human reading fstab exactly what happened); *delete* = entry and credentials gone. Parser fail-open rule: a `#ANAS `-prefixed line whose remainder isn't a valid fstab entry is an ordinary comment, never touched. `disabled` is an intentional state — grid pill, never a dashboard warning.
> - **Edit round-trip fix (2026-07-25):** the Edit dialog came up with Server/Share blank, options/username empty, and Save stuck disabled — the summary row carries neither the parsed spec parts nor the structured options/credentials. Fixed: the daemon now owns spec parsing (`parseSpec`, the exact inverse of the write-side `buildSpec`; CIFS `//server/share` incl. backslash + multi-segment, NFS `server:/export` incl. `[ipv6]:/export`), exposing `server`/`remotePath` on every remote inventory row (and thus detail); the edit dialog fetches `GET /mounts/:mp` and populates every field from the parsed spec + `configuredOptions` + the saved CIFS username (password blank = keep existing, so a no-password edit never rotates/wipes the 0600 creds file). Cosmetic: local (non-remote/PVE/AHR) rows get a `LOCAL — managed under Pools` badge mirroring the PVE/AHR hands-off markers.

18.6. [OBE 2026-07-18 — operator ruling] As a user, I want removable drives handled as removable: hotplug detection in the inventory, a safe-eject action (unmount + flush, device power-off where the tooling supports it), and a warning when a share or backup task rides on the device I'm ejecting — so pulling a USB drive is safe by default. *(Descoped: removable drives are not ANAS's problem — standard Linux handles them.)*

18.7. [OBE 2026-07-18 — operator ruling] As a user, I want to format a blank spare/external disk (single disk, ext4/xfs) behind the 409 confirmation gate, so a drive fresh from the store becomes usable without leaving ANAS. *(Descoped with 18.4: a blank disk's path into ANAS is a ZFS pool/vdev (Epic 3 composer), later md/SHR (Epic 11) — never a bare ext4 single. Epic 11 will build its own disk-preparation layer when prioritized.)*

##### Refinement
18.8. [done 2026-07-25 — parser round-trips proven for every new option; octal→human helper unit-tested; suite 1133 daemon + 30 gateway green; live-verified on the stunt node] As a user, I want the Add/Edit Remote Share dialog to expose the mount options a real NAS user actually sets — not just the handful shipped in 18.5 — with human-readable permission display and a preview box that isn't clipped, so I don't have to hand-type them into the free-text passthrough. *Curated a COMMON tier from `mount.cifs(8)` and `nfs(5)`/`mount(8)` (authoritative man pages) and modeled it as first-class shared Zod, leaving the long tail in the verbatim `passthrough`:*
> - **Common (both fstypes):** surfaced the already-modeled `_netdev` (the operator's flagged gap — now a real toggle the daemon honours, still defaulting on for remote) and added `noexec` (the nosuid/nodev hardening trio's third leg).
> - **CIFS:** `cache` (strict/loose/none), `mfsymlinks`, `forceuid`/`forcegid` (paired with the uid/gid pickers), `noserverino`, `nobrl`, `actimeo`, `rsize`/`wsize`, `sec` (ntlmssp/ntlmv2/ntlmv2i/ntlm/ntlmi/krb5/krb5i/ntlmsspi/none), `iocharset`. **Excluded** (left to passthrough): `mapchars`/`mapposix`, `nostrictsync`, `echo_interval`, `closetimeo`, `handletimeout`, `sfu`, `domainauto` — Windows-SFU interop and rarely-touched tuning knobs.
> - **NFS:** `proto` (tcp/udp/rdma), `sec` (sys/krb5/krb5i/krb5p/none), `noac`, `actimeo`, `nconnect` (modern multi-connection throughput, 1–16), `bg`, `lookupcache` (all/none/pos/positive); `soft` stays the hard/soft toggle. **Excluded** (passthrough): `noresvport`, `nordirplus`, `local_lock`, `softerr`, IPv6 transports, `port`/`mountport` — the long tail.
> - **Round-trip discipline:** the parser recognizes every new token into its tier (an *unrecognized* enum value — e.g. `cache=bogus` — round-trips VERBATIM in passthrough, never a schema violation on the way back out); `buildOptionTokens` serializes them back; parse→build→parse is identity. Preserved 18.5's inline-credential extraction and the mid-field-`#`-in-password handling (f55bd5f) untouched.
> - **Human-readable permissions:** `file_mode`/`dir_mode` keep the authoritative octal input and gain a live translation — symbolic (`rw-r--r--`) plus a plain gloss (`Owner: read & write · Group: read · Others: read`) — from a SINGLE shared helper `ANAS.fmtMode(octal)` in 00-core (reusable for future POSIX-perm displays; handles 3-/4-digit and invalid input gracefully).
> - **UI:** the rarer options live behind an "Advanced NFS/CIFS options" collapsible so the form stays approachable; every control drives the live fstab-line preview; the preview box got line-height + min-height so the monospace line is no longer vertically clipped.
