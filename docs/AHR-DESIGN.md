# AHR (ANAS Hybrid RAID) — Design

> Design draft for the V2 headline (Epic 11 + AHR). No code yet. Ground truth still to be captured by BUILDING the stack on the stunt node (see EPICS Epic 11 kickoff notes); this document is the plan that capture will confirm or correct. Reference: the OpenMediaVault "build an SHR on plain Linux" howto + Synology's published SHR behavior. Everything here is subordinate to docs/PRINCIPLES.md and the guest philosophy — deviations are allowed only deliberately and with knowledge, and this doc names each one where it occurs.
>
> **Naming:** the feature is **AHR — ANAS Hybrid RAID** (tiers AHR-1 / AHR-2). "SHR" is Synology's name and is used below only when referring to Synology's implementation as the reference model. UI labels lead with what the tier *means* — "1-disk fault tolerance" / "2-disk fault tolerance" — the tier acronym is API vocabulary.
>
> **Deliberate exclusions (not vestiges — decided, not deferred):**
> - **No ext4.** btrfs is the only filesystem. ext4 was a Synology legacy option for pre-btrfs models; we have no legacy. btrfs-only means every pool has checksums and scrub — half the integrity story.
> - **No AHR-1 → AHR-2 conversion.** Synology supports tier upgrade of an existing pool; we have no installed base to migrate. Pick the tier at creation.
> - **No compatibility/upgrade machinery of any kind.** There are no old ANAS pools to upgrade from.

## 1. What AHR is (and what ANAS is building)

SHR-style hybrid RAID is **orchestration over a fully open stack** — nothing proprietary in the layers, only in Synology's decision logic:

```
disks → GPT partitions (size-matched "region" slices)
      → one mdadm array per region  (redundancy lives HERE)
      → LVM: all arrays concatenated into one VG → one LV
      → btrfs on the single LV  (filesystem ONLY — never btrfs-RAID)
```

The differentiated ANAS work is the orchestration Synology keeps closed:
1. **The layout algorithms** — fresh-create banding (§2.1) AND the incremental expansion planner (§2.3) — these are different algorithms.
2. **Online growth** — the resumable, multi-layer expansion job (the hard, dangerous part).
3. **Degraded/recovery handling** across all three layers.

**Non-negotiable rule:** redundancy is md's job. btrfs runs on a single already-redundant LV and is *never* configured for btrfs-native RAID5/6 (unstable). This is enforced in code, not just documented.

## 2. The layout algorithms

### 2.1 Fresh-create region slicing

Sort disks ascending by usable size `d_1 ≤ d_2 ≤ … ≤ d_n`. The distinct sizes define **band boundaries** `B_0=0 < B_1 < … < B_k`. For band `i` spanning `[B_{i-1}, B_i]`:

- **Participating disks** = those with size ≥ `B_i` (count `m_i`).
- **Band height** `h_i = B_i − B_{i-1}`.
- Each participating disk gets one partition of size `h_i` in that band.
- The `m_i` partitions form ONE mdadm array:
  - **AHR-1:** `m_i = 1` → unprotected, **not used** (wasted); `m_i = 2` → RAID1; `m_i ≥ 3` → RAID5.
  - **AHR-2:** `m_i < 4` → **not used**; `m_i ≥ 4` → RAID6.

Usable capacity of a used band = `h_i × (m_i − 1)` for AHR-1 (RAID1 and RAID5 both lose one disk's worth), `h_i × (m_i − 2)` for AHR-2.

**This algorithm applies only at pool creation.** Once arrays exist, band boundaries are historical facts; expansion uses §2.3.

### 2.2 Worked examples (band math verified against Synology's SHR calculator)

**2+3+4 TB, AHR-1:**
| Band | Range | Disks | Array | Usable |
|---|---|---|---|---|
| 1 | 0–2 | 3 (all) | RAID5 | 2×(3−1) = 4 |
| 2 | 2–3 | 2 (3,4) | RAID1 | 1×(2−1) = 1 |
| 3 | 3–4 | 1 (4) | — wasted | 0 |

Usable = **5 TB** ✓ (Synology: 2+3+4 → 5 TB)

**1+2+3+4 TB, AHR-1:** bands give 3 + 2 + 1 + 0 = **6 TB** ✓
**4+4 TB, AHR-1:** one RAID1 band → **4 TB** ✓
**4×4 TB, AHR-2:** one RAID6 band → 4×(4−2) = **8 TB** ✓

**Caveat on "verified":** the *band-level* math matches. Real usable numbers will be slightly lower — each band array pays md metadata + data-offset overhead (can be ~128 MiB per member, and the offset headroom is load-bearing, see §5.1), plus GPT/alignment slack. The capacity model must subtract measured per-array overhead; ground-truth stage captures the real constants.

### 2.3 The incremental expansion planner (existing bands are constraints)

A fresh §2.1 layout for the post-expansion disk set is generally **unreachable** from an existing pool — you cannot move a boundary between populated bands without rewriting everything. Example: 2+3+4 TB has bands [0–2]×3, [2–3]×2, [3–4]×1. Replace the 2 TB with a 4 TB (disks now 3+4+4): fresh-ideal would be [0–3]×3 + [3–4]×2, but the 0–2/2–3 boundary is immovable. The reachable target is: keep [0–2] RAID5×3, **convert+grow** [2–3] RAID1×2 → RAID5×3, **create** [3–4] RAID1×2. (Capacity happens to converge here — 7 TB either way — but that is not guaranteed in general; the planner reports reachable capacity, never fresh-ideal capacity.)

The planner's rules:
- **Existing band boundaries are immutable.** New boundaries may only be added *above* the current top boundary.
- Per band, the only legal moves are: **add members** (grow width, same level), **convert level upward** when member count crosses a threshold (RAID1×2 → RAID5×3+ for AHR-1 — a distinct mdadm level-change reshape, not a plain grow), and **create** a new array in a new top band.
- **Arrays are never renumbered, shrunk, or re-sliced.** Band indices strictly append (naming invariant, §2.6).
- Input: existing bands + the disk set the operator approved. Output: an ordered step list (§5).

This "recompute the reachable target from existing bands + present disks" rule is also what makes resume nearly stateless — see §5.3.

### 2.4 The "wasted top slice" property

The top band of the single largest disk is always single-member → unprotected → unused. This is inherent to AHR-1 (you can never protect the tallest sliver of one disk). The UI must show this as **"unprotected capacity (unusable until another disk of ≥X is added)"**, not silently drop it — an unlabeled gap between raw and usable is exactly the confusion this project bans.

### 2.5 Replacement-slack reserve (critical, easy to get wrong)

"Same size" drives vary by tens of MB; a 4 TB replacement can be marginally smaller than the 4 TB it replaces, and md refuses a member that's even one block short. So the **usable size of every disk is rounded DOWN** to a coarse granularity (proposal: floor to the nearest whole GiB, with a fixed small reserve — capture the real safe value on the stunt node). Band boundaries are computed on the rounded sizes. This trades a little capacity for the guarantee that a nominally-same replacement always fits. Ground-truth stage must measure real-world disk-size variance to fix the reserve.

### 2.6 Alignment & on-disk conventions

- GPT, 1 MiB partition alignment, band boundaries aligned to the reserve granularity.
- Partition type GUID = Linux RAID (`A19D880F-…`).
- mdadm metadata 1.2 with **explicit, generous data offset** (reshape headroom — §5.1); arrays named deterministically so assembly is reproducible (`md/<pool>-r<band>`).
- **Naming invariant:** band indices strictly append across the pool's life; an existing array keeps its name forever. The §2.3 planner guarantees this.
- LVM: one VG per pool (`<pool>`), one LV (`<pool>-vol`); PVs are the md devices in band order.
- btrfs single-device (`-d single -m dup`) on the LV. Mounted under a pool-scoped mountpoint (never `/mnt/pve`).

## 3. Data structures (shared Zod schemas)

New `packages/shared/src/schemas/ahr.ts`. All validated at both boundaries.

```
AhrType      = 'ahr1' | 'ahr2'
ArrayLevel   = 'raid1' | 'raid5' | 'raid6'
ArrayState   = 'clean' | 'degraded' | 'resyncing' | 'reshaping' | 'recovering' | 'failed'
PoolState    = 'healthy' | 'degraded' | 'expanding' | 'rebuilding' | 'scrubbing' | 'failed' | 'readonly'
```

(Initial RAID5/6 sync after create reports as `resyncing`; the UI copy must present it as "building — pool usable now", distinct from degraded.)

**`AhrDisk`** — `{ id (by-id), sizeBytes, usableBytes (rounded), model, serial, role: 'member'|'spare', partitions: [{ device, band, sizeBytes }] }`

**`AhrArray`** (one region array) —
`{ device (md), band, level, heightBytes, members: [{ disk, partition, memberState: 'in_sync'|'faulty'|'spare'|'rebuilding'|'missing' }], state, sync?: { action: 'resync'|'reshape'|'recover'|'check', percent, speedBytesSec, etaSeconds } }`

**`AhrCapacity`** — the labeled breakdown the UI renders (never a bare number):
`{ rawBytes, usableBytes, usedBytes, freeBytes, redundancyOverheadBytes, unprotectedWastedBytes, pendingBytes }`
- `pendingBytes` = capacity physically present but not yet usable because too few disks cross a boundary (the "unlock" state, §5.2).

**`AhrPool`** — `{ name, ahrType, mountpoint, disks: [AhrDisk], arrays: [AhrArray], vg: { name, sizeBytes, freeBytes }, lv: { name, sizeBytes }, capacity: AhrCapacity, state, advisories: [string] }`

**`AhrLayoutPreview`** (dry-run, no mutation) — the composer's live feedback: `{ bands: [{ range, memberCount, level, heightBytes, usableBytes, protected: bool }], capacity: AhrCapacity, warnings, minDisksMet: bool }`

**`AhrExpansionIntent`** (the ONLY persisted expansion state — see §5.3) —
`{ id, trigger: 'add-disk'|'replace-disk', approvedDisks: [diskId], replacedDisk?: diskId, before: AhrCapacity, after: AhrCapacity, state: 'running'|'halted'|'done'|'abandoned' }`

**`AhrExpansionStep`** (derived, never persisted — recomputed by the §2.3 planner on every run/resume) —
`{ index, kind, target, status: 'pending'|'running'|'done'|'failed', detail? }`
where `kind ∈ 'partition' | 'array-create' | 'array-grow' | 'array-convert' | 'reshape-wait' | 'pv-create' | 'pv-resize' | 'vg-extend' | 'lv-extend' | 'fs-grow'`.
- `array-convert` is the RAID1→RAID5 level-change reshape (§2.3) — a distinct mdadm operation with its own failure modes, not an `array-grow`.

## 4. Actions / API

New resource `/v1/ahr` (parallel to `/v1/pools`; md/AHR is a distinct backend per Epic 11). Reuses `/v1/disks`, and shares/backup/mounts consume its mountpoint like any path.

| Method | Path | Description | Response |
|---|---|---|---|
| `GET` | `/v1/ahr` | List AHR pools (summary) | 200 |
| `GET` | `/v1/ahr/:name` | Full pool detail (the §3 structure) | 200 |
| `POST` | `/v1/ahr/layout/preview` | Dry-run layout for a disk selection + tier — NO mutation | 200 |
| `POST` | `/v1/ahr` | Create pool (wipes selected disks) | 202 job / **409 confirm** |
| `POST` | `/v1/ahr/:name/expand/plan` | Compute the expansion plan (before→after) — NO mutation | 200 |
| `POST` | `/v1/ahr/:name/expand` | Execute expansion (add or replace) | 202 job / **409 confirm** |
| `POST` | `/v1/ahr/:name/expand/resume` | Re-run a halted expansion (recompute-and-continue) | 202 job |
| `POST` | `/v1/ahr/:name/expand/abandon` | Abandon a halted expansion intent (pool stays as-is) | 202 job / **409 confirm** |
| `POST` | `/v1/ahr/:name/disk/:id/replace` | Guided single-disk replace | 202 job / **409 confirm** |
| `POST` | `/v1/ahr/:name/scrub` | btrfs scrub, then md `check` — sequenced, never concurrent | 202 job |
| `DELETE` | `/v1/ahr/:name` | Destroy pool | 202 job / **409 confirm** |

**Confirm-gated (Principle 14, the 409 + X-Anas-Confirm-Code flow):** create (wipes disks — lists every disk that will be erased in the warnings), expand/replace (announces reshape duration estimate + the pending-capacity reality), abandon (leaves the pool at reachable-but-not-target layout — states exactly what that layout is), destroy. The confirm warnings carry the *concrete* consequence (which disks, how long, how much data at risk), not a generic "are you sure".

**Pre-checks:** `expand` REFUSES to start while any array is degraded (reshaping a degraded array voluntarily enters the double-failure window — replace/rebuild first). A replacement disk smaller than the reserved usable size is rejected before any destructive action (§2.5).

All mutations are jobs (202). execFile only: `sgdisk`/`parted`, `mdadm`, `pvcreate`/`vgcreate`/`vgextend`/`lvcreate`/`lvextend`, `mkfs.btrfs`/`btrfs`, `wipefs`. Every user-derived value (pool name, disk id) is schema-constrained to a safe charset (the security-hardening pattern); `--` end-of-options guards on positional args. Scrub runs btrfs scrub and md `check` **sequentially** — both are full-device reads and would thrash each other concurrently. (Scheduled scrubs are Epic 17's job.)

## 5. The resumable multi-layer expansion job (the dangerous part)

### 5.1 Step pipeline

An expansion is an ordered, **idempotent, resumable** step list. Each step first *detects current state* and computes the remaining delta, so a re-run after interruption is a no-op for completed steps:

```
partition (new/replaced disk) → array-create OR array-grow OR array-convert (mdadm)
  → reshape-wait (monitor md; the kernel owns resumability here)
  → pv-create/pv-resize → vg-extend → lv-extend → fs-grow (btrfs)
```

- **md reshape is kernel-resumable ONLY when offset-based.** `mdadm --grow` uses data-offset headroom for the critical section when it can; when it can't, it demands `--backup-file=` — and then resume-after-power-loss requires re-supplying that file at assembly. **Lose it and the array may be unassemblable.** That is critical hidden state, worse than any plan file, and AHR **mandates offset-based reshapes**: arrays are created (§2.6) with explicit generous data offsets, and the ground-truth stage must verify that every grow/convert we perform proceeds with NO backup file — including the widest-grow case. If any operation turns out to require one, that operation is redesigned or dropped, not backed by a file we promise not to lose.
- On power loss mid-reshape, md resumes on next assembly. ANAS detects "reshape in progress" at boot/daemon-start and *re-attaches monitoring* rather than restarting anything. `reshape-wait` polls `/proc/mdstat` + `mdadm --detail`.
- **Ordering safety:** the filesystem is only grown as the LAST step, and only after the LV is confirmed extended. Never grow the fs before the block device beneath it.
- **A step failure halts the pipeline** in a known state; the pool remains whatever it is (usually still mounted and usable — degraded, not down), the intent goes to `halted`, and ANAS reports exactly which layer stopped. The operator's verbs are `expand/resume` (idempotent recompute-and-continue) and `expand/abandon`.
- **Replace uses `mdadm --replace`, never fail-then-rebuild.** When the outgoing disk is still alive (the proactive-upgrade case — the headline use case), `--replace` copies onto the new member while the old one stays in-array, so redundancy is never lost. Fail/remove-then-add would drop every band the disk touches to degraded — voluntarily running the second-failure exposure §7.2 warns about. Fail-then-rebuild is only for disks that are already dead.
- **One replaced disk touches N arrays** (one per band). Rebuild/replace sequencing across those arrays — sequential vs parallel on the same spindle — is a ground-truth decision (parallel likely thrashes; md may serialize on its own; measure it).

### 5.2 Pending capacity ("unlock") — the expansion UX truth

For AHR-1, replacing ONE disk with a larger one yields **zero new usable space** — you need ≥2 disks above a boundary to form a protected array in the new band. The pool enters a state where physical capacity exists (`pendingBytes > 0`) but is locked. The UI must state, concretely: *"Replaced 4 TB → 8 TB. No new space yet. Replace one more disk with ≥8 TB to unlock ~4 TB."* Getting this wrong (showing the raw new size as available) is the single most confusing thing hybrid RAID does; ANAS names it explicitly.

### 5.3 Resume = recompute-and-continue (shadow state minimized, deliberately)

Per the guest philosophy, the *system* is the source of truth: pool topology is reconstructed from `mdadm --detail --scan`, `pvs`/`vgs`/`lvs`, `btrfs filesystem show`, and the GPT partition tables — ANAS does not keep a duplicate registry of what the pool IS.

The draft's open question — can resume be fully stateless? — resolves to **no, but almost**. Pure "drive toward the ideal layout for the current disk set" is unsafe twice over: the fresh-ideal layout is generally unreachable from existing bands (§2.3), and a stateless reconciler cannot distinguish *disk failed* from *disk deliberately removed* — after a failure, the "ideal layout for what's present" is smaller, and driving toward it would destroy data. **A missing disk is NEVER treated as intent.**

So the persisted state is exactly one small record: the **`AhrExpansionIntent`** — the disk set the operator approved, nothing more. Steps are never persisted; on every run and every resume, the §2.3 planner recomputes the reachable target from (existing bands + the approved disk set) and continues from wherever the system actually is — each step is a detect-then-delta no-op if already done. This is a deliberate, known Principle-11 deviation, minimized to the one fact genuinely not derivable from the system (what the operator intended), mirroring the replication model (systemd units are the store; ZFS state is the truth). Storage location: a small root-owned state file under the daemon's own directory (exact path at build time).

## 6. UI

Reuses `ANAS.gfx` (disk/bay objects, activity strip) and the pool-composer patterns from 3.23.

### 6.1 Create composer (AHR-aware)
- Disk multi-select (from `/v1/disks`, excluding ZFS/PVE/mounted/in-use disks, with the hands-off tagging already built).
- Fault-tolerance toggle: **"1-disk fault tolerance (AHR-1)" / "2-disk fault tolerance (AHR-2)"** — lead with the meaning, not the acronym. btrfs is the filesystem (stated, not chosen; RAID-in-md note shown).
- **Live sliced-layout visualization**: horizontal disks, stacked bands, each band colored by its array, protected bands solid, the wasted top slice hatched/greyed with its label. Driven by `/v1/ahr/layout/preview` on every selection change.
- **Capacity readout** — the labeled `AhrCapacity` breakdown (usable / redundancy overhead / unprotected-wasted), never a bare number.
- **Advisor callouts** (the "guide, don't just warn" thesis): "these two 2 TB disks limit your 8 TB disks — add a second large disk to use their full size", min-disk-not-met, "2-disk fault tolerance needs ≥4 disks", etc.
- Commit disabled while invalid; Create → 409 confirm listing every disk to be wiped.

### 6.2 Pool detail
- **Layered stack visualization**: disks → region bands → md arrays → LVM → filesystem, each layer's health inline. A faulted disk lights its bay red and marks every array it participates in.
- Per-array state + an **activity strip** for any running sync/reshape/recover/check (percent, speed, ETA) — reuses the scrub/resilver strip idiom.
- **Capacity breakdown** including `pendingBytes` with its unlock explanation.
- Actions: Expand, Replace disk, Scrub, Destroy — each opening its wizard. A halted expansion surfaces Resume / Abandon here, loudly.

### 6.3 Expansion wizard
- Choose **Add disk** or **Replace disk**; pick the disk(s).
- `/v1/ahr/:name/expand/plan` → show **before → after** capacity, the step list, and prominently: the **reshape duration estimate** (hours, on large arrays) and the **pending-capacity outcome** if applicable ("this unlocks nothing yet — one more disk needed").
- FULL warnings: the pool stays online during reshape but performance degrades; a reshape can't be cancelled mid-flight cleanly; power loss is survivable (md resumes) but don't yank disks.
- Blocked with explanation if the pool is degraded (§4 pre-check): replace/rebuild first.
- Confirm gate → job with the live activity strip.

## 7. PVE logs & notifications

### 7.1 journald (audit + forensics)
Every mutation audit-logged via the existing pattern (who / what / when / result). The expansion job logs **structured step transitions** to journald: `ahr.expand step=array-grow band=2 status=running`, milestone reshape progress (e.g. every 10%), and completion — labeled as forensics (journald rotates; authoritative pool state is always the live read of md/LVM/btrfs).

### 7.2 PVE notification system (finally builds 9.4/9.5)
AHR is the feature that justifies actually wiring the deferred Proxmox notification client — these are the **unattended, non-interactive** events an operator must learn about when not watching the UI:

| Event | Severity | Why it must notify |
|---|---|---|
| Array degraded (disk faulted) | warning | redundancy lost — replace before a second failure |
| Rebuild/recover complete | info | redundancy restored |
| Reshape complete (expansion done) | info | new capacity available / unlock progressed |
| Reshape/expansion FAILED | error | pool stuck mid-transition, needs attention |
| Disk failed DURING reshape | error | reshape continues degraded — combined-risk state (§8) |
| Second disk failure / array failed | **critical** | data loss imminent/occurring; pool may go read-only |
| Pool read-only (btrfs forced ro) | **critical** | fs protecting itself |
| Scrub found (and could/could not correct) errors | warning/error | latent corruption surfaced |

Routed through PVE's own notification targets/matchers (email/Gotify/etc. the operator already configured) — ANAS emits, PVE delivers. Leverage, not a new alerting system. **Evaluate first (per 9.4):** does ZED/mdadm's own `MAILADDR`/monitor already cover the disk-failure cases? Wire only the genuinely-missing events; don't duplicate `mdadm --monitor` if PVE can consume it directly.

### 7.3 Dashboard
Only failures and in-progress operations surface (the replication/backup policy): a degraded/failed/read-only pool → warning card; a running reshape/rebuild → the jobs strip with progress. Healthy/idle shows nothing.

## 8. Failure & recovery model

- **Degraded ≠ down**: a single-disk failure in an AHR-1 band keeps the pool fully usable (that's the point). ANAS surfaces it loudly (dashboard + notification) but does not stop service.
- **Reshape interrupted** (power loss): md resumes automatically on assembly (offset-based reshapes only — §5.1); ANAS re-attaches monitoring, never re-issues the reshape.
- **Disk fails DURING a reshape** (the scariest real case): md continues the reshape degraded. ANAS must detect the combined state (reshaping + degraded), notify at `error` severity, keep monitoring, and refuse further operations until the reshape completes and the disk is replaced. **Mandatory stunt-node failure drill** — force this scenario on throwaway data before shipping.
- **Step failure**: pipeline halts, intent → `halted`, pool left in a known intermediate state (never fs-mounted-rw during an unsafe block-layer transition); ANAS reports the exact layer + offers Resume (idempotent recompute-and-continue) or Abandon.
- **btrfs read-only trip**: surfaced as critical; ANAS never force-remounts rw (the fs is protecting data) — points the operator at diagnosis.
- **Marginal replacement disk** (too small by a hair): caught before any destructive action via the §2.5 reserve pre-check, with a clear message.
- **Never btrfs-RAID**: enforced at pool creation — btrfs is always `-d single -m dup` on the one LV.

## 9. Open questions for review

1. ~~Plan shadow state~~ **Resolved (§5.3):** persist only the approved-disk-set intent; steps are always recomputed. A missing disk is never treated as intent.
2. **Replacement reserve granularity (§2.5):** floor-to-GiB vs a fixed percentage vs a measured constant — needs the stunt-node disk-variance capture.
3. **AHR-2 min-disk and small-band handling:** confirm behavior when a top band has 2–3 members under AHR-2 (unprotected-for-2? RAID1? wasted?) against a real build.
4. **Reshape resource throttling** (`/proc/sys/dev/raid/speed_limit_*`) — tune during reshape or leave kernel defaults? Ground-truth it. Same session: measure sequential-vs-parallel multi-band rebuild on one spindle (§5.1).
5. **Data-offset sizing (§5.1):** what offset guarantees backup-file-free grows and converts at every width we support? Ground-truth with the widest case.
6. **Notification overlap (§7.2):** measure what `mdadm --monitor` / ZED already deliver on a PVE node before building the client.
7. **Foreign SHR pool adoption (parked, real scope):** because the stack is identical, disks pulled from a dead Synology will likely just assemble as md+LVM on a PVE node. Recognizing/adopting a foreign hybrid pool (read-only rescue at minimum) could be a killer migration story — decide deliberately later; not designed here.

~~API home~~ **Resolved:** `/v1/ahr`, sibling of `/v1/pools` — decided with the naming.
