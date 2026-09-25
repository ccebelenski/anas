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

**Caveat on "verified":** the *band-level* math matches. Real usable numbers will be slightly lower — each band array pays md metadata + data-offset overhead (256 MiB per member on TB-scale disks — GT-5 calibrated; the offset headroom is load-bearing, see §5.1), plus GPT/alignment slack. The capacity model must subtract measured per-array overhead; ground-truth stage captures the real constants.

### 2.3 The incremental expansion planner (existing bands are constraints)

A fresh §2.1 layout for the post-expansion disk set is generally **unreachable** from an existing pool — you cannot move a boundary between populated bands without rewriting everything. Example: 2+3+4 TB has bands [0–2]×3, [2–3]×2, [3–4]×1. Replace the 2 TB with a 4 TB (disks now 3+4+4): fresh-ideal would be [0–3]×3 + [3–4]×2, but the 0–2/2–3 boundary is immovable. The reachable target is: keep [0–2] RAID5×3, **convert+grow** [2–3] RAID1×2 → RAID5×3, **create** [3–4] RAID1×2. (Capacity happens to converge here — 7 TB either way — but that is not guaranteed in general; the planner reports reachable capacity, never fresh-ideal capacity.)

The planner's rules:
- **Existing band boundaries are immutable.** New boundaries may only be added *above* the current top boundary.
- Per band, the only legal moves are: **add members** (grow width, same level), **convert level upward** when member count crosses a threshold (RAID1×2 → RAID5×3+ for AHR-1 — a distinct mdadm level-change reshape, not a plain grow), and **create** a new array in a new top band.
- **Arrays are never renumbered, shrunk, or re-sliced.** Band indices strictly append (naming invariant, §2.6).
- Input: existing bands + the disk set the operator approved. Output: an ordered step list (§5).
- **"Existing bands" means existing arrays**: the append-only top boundary is the highest *array's* boundary, not the tallest disk's — the region above it (including any wasted top slice) is free for re-banding.
- **Replace is a declared substitution**: the planner takes an explicit `{oldDiskId, newDiskId}` pair; the replacement inherits the old disk's band memberships and is size-checked against every band it joins (§2.5). Bands whose member count and level are unchanged get NO plan step — the physical swap is `mdadm --replace`'s job (§5.1), not a layout change.
- **Stranded capacity is named, not dropped**: a disk whose size falls strictly between immovable existing boundaries (e.g. a 2.5 TB disk against 2/3 boundaries) has permanently unusable slack; the planner reports it in `unprotectedWastedBytes` with a per-disk warning.

This "recompute the reachable target from existing bands + present disks" rule is also what makes resume nearly stateless — see §5.3.

### 2.4 The "wasted top slice" property

The top band of the single largest disk is always single-member → unprotected → unused. This is inherent to AHR-1 (you can never protect the tallest sliver of one disk). The UI must show this as **"unprotected capacity (unusable until another disk of ≥X is added)"**, not silently drop it — an unlabeled gap between raw and usable is exactly the confusion this project bans.

### 2.5 Replacement-slack reserve (critical, easy to get wrong)

"Same size" drives vary by tens of MB; a 4 TB replacement can be marginally smaller than the 4 TB it replaces, and md refuses a member that's even one block short. So the **usable size of every disk is rounded DOWN** to a coarse granularity (proposal: floor to the nearest whole GiB, with a fixed small reserve — capture the real safe value on the stunt node). Band boundaries are computed on the rounded sizes. This trades a little capacity for the guarantee that a nominally-same replacement always fits. Ground-truth stage must measure real-world disk-size variance to fix the reserve.

### 2.6 Alignment & on-disk conventions

- GPT, 1 MiB partition alignment, band boundaries aligned to the reserve granularity.
- Partition geometry (ground truth GT-4): interior slice `[B_{i-1}, B_i)` = start `B_{i-1}`, size `B_i − B_{i-1}` (sgdisk end positions are inclusive — never end "at" a boundary); each disk's topmost slice clamps to the last usable sector (backup GPT eats the final 33).
- **Unused regions are NOT partitioned** — the area above the top array boundary (wasted top slice included) stays raw so a future expansion can band it to whatever granularity the new disk set dictates.
- Partition type GUID = Linux RAID (`A19D880F-…`).
- mdadm metadata 1.2 with **explicit `--data-offset`** — the mdadm default VARIES with member size (GT-5), so ANAS pins a generous deterministic value for reshape headroom (§5.1). Calibrated (GT-5, 2026-07-24): **256 MiB for members ≥ 128 GiB** (≥ mdadm's own native 129 MiB plateau, verified to 15.6 TiB), 4 MiB below. Per-member offsets legitimately diverge after grows (GT-6) — parsers must not assume uniformity.
- **Explicit `--bitmap=internal`** on every array (2026-07-23) — md's write-intent bitmap is the differential-resilver analog: a transiently-offline member `--re-add`s with a fast catch-up sync of only the regions written while it was gone, instead of a full rebuild. mdadm defaults this only for ≥100 GB members; ANAS never relies on the implicit default (same doctrine as data-offset).
- Arrays named deterministically (`md/<pool>-r<band>`) and **pinned via ARRAY entries in `/etc/mdadm/mdadm.conf`** (operator decision 2026-07-22; surgical edits, config-files-are-the-API) so `/dev/md/` names are deterministic across assembly paths. Code still resolves arrays by superblock name/UUID via `mdadm --detail --export` defensively — the GT-3 instability exists on any pool ANAS didn't pin (foreign/pre-existing arrays).
- **Naming invariant:** band indices strictly append across the pool's life; an existing array keeps its name forever. The §2.3 planner guarantees this.
- LVM: one VG per pool (`<pool>`), one LV (`<pool>-vol`); PVs are the md devices in band order.
- btrfs single-device (`-d single -m dup`) on the LV. Mounted under a pool-scoped mountpoint (never `/mnt/pve`).

## 3. Data structures (shared Zod schemas)

New `packages/shared/src/schemas/ahr.ts`. All validated at both boundaries.

```
AhrType      = 'ahr1' | 'ahr2'
ArrayLevel   = 'raid1' | 'raid5' | 'raid6'
ArrayState   = 'clean' | 'degraded' | 'resyncing' | 'reshaping' | 'recovering' | 'inactive' | 'failed'
AhrPoolState = 'healthy' | 'building' | 'degraded' | 'expanding' | 'rebuilding' | 'scrubbing' | 'offline' | 'failed' | 'readonly'
```
(`AhrPoolState`, not `PoolState` — zfs.ts already owns that export name.)

(Initial RAID5/6 sync after create reports as `resyncing`; the UI copy must present it as "building — pool usable now", distinct from degraded.)

(`building` is the whole-pool form of that: EVERY band syncing or queued, with no faulty or absent member anywhere. md serializes syncs across arrays sharing physical disks, so a mixed-media pool's later bands sit `resync=DELAYED` at `[n/n-1]` with no progress line — a shape that must read as build activity, never as a degraded array with a failed disk. It is a NEUTRAL pill, not a fault, and it suppresses the failure card for the whole multi-day build. **The advisories say only what the kernel actually recorded** — `syncing onto <disk> — no fault recorded`, or `sync queued behind another band — no fault recorded` — and never "building redundancy" or "no action needed" (issue #15): mdstat is byte-identical between a first build (`[3/2] [UU_]`) and a rebuild onto a spare whose dead disk was PULLED (`[3/2] [_UU]`) — no `(F)` in either, and the superblock records no "has ever been optimal". A confident "no action needed" is therefore a verdict on the one question the evidence cannot settle, and the exactly wrong one for the pulled case. Discriminating them needs a signal mdstat does not carry (array creation time is the candidate, recorded on #15, not built); shadow-state markers were considered and REJECTED — a stale marker fails in the direction that MASKS a real disk pull (PRINCIPLES §11, stateless). A pool being built by a live `ahr.create` job reports `building` even before its VG exists: the half-built stack is indistinguishable on disk from a create that died, so the read layer consults the job queue — jobs are runtime state, not shadow state, and after a daemon restart the answer honestly reverts to `failed`.)

(`offline` is TOTAL UNAVAILABILITY, and it exists because `degraded` was being asked to carry it (issue #18): after a node lockup, `chiaahr2` came up with band r1 active-degraded, bands r2 and r3 INACTIVE ("active, FAILED, Not Started"), the VG missing 2 of 3 PVs and the LV not active — nothing was readable, and the badge said "degraded". Derivation: **any** band md array inactive/failed/not-started, **or** the pool's LV present but not active (`lv_attr` state field ≠ `a`). A band that cannot start takes its PV with it, so the concatenated volume is missing a piece and NO band is reachable — not a reduced-redundancy state at all. It therefore **outranks** degraded/building/expanding/rebuilding/scrubbing/readonly in the fusion; only `failed` (the LVM layer gone outright) ranks above it. Red pill, uppercase label, critical card, and the advisory names which band arrays cannot start. It does NOT diagnose a cause — an inactive array may be the recoverable GT-8 all-spares assembly (§5.1's ladder) or genuinely missing members, and the per-array advisories are what say which.)

(`inactive` is the band-level counterpart of that pool verdict, and the follow-up to it: issue #18 shipped `offline` and deliberately left the band reading `degraded` ("no schema widening for a tone"). It is not a tone. On the post-lockup shape r1 was genuinely active and down a member while r2 and r3 could not start at all, and one amber word for both hid the fact recovery turns on — WHICH bands failed to assemble. Derivation is a direct read of mdstat's array header (`inactive`), the same single flag the pool's `offline` verdict uses, so the two levels can never disagree: a band that reads `inactive` always sits in a pool that reads `offline`. Red pill, label "CANNOT START" — the same words as the advisory and the card. Bands that DID start keep their own honest state beside it; the pool badge carries the whole-volume verdict, and the band badges say where the damage is. Operations gate on it: expansion refuses an `inactive` band or an `offline` pool outright, and snapshot mutations and scrub refuse an `offline` pool because there is no mounted filesystem to act on.)

**`AhrDisk`** — `{ id (by-id), sizeBytes, usableBytes (rounded), model, serial, role: 'member'|'spare', partitions: [{ device, band, sizeBytes }] }`

**`AhrArray`** (one region array) —
`{ device (md), band, level, heightBytes, members: [{ disk, partition, memberState: 'in_sync'|'faulty'|'spare'|'rebuilding'|'missing' }], state, sync?: { action: 'resync'|'reshape'|'recover'|'check', percent, speedBytesSec, etaSeconds } }`

**`AhrCapacity`** — the labeled breakdown the UI renders (never a bare number):
`{ rawBytes, usableBytes, usedBytes, freeBytes, redundancyOverheadBytes, unprotectedWastedBytes, pendingBytes }`
- `pendingBytes` = capacity physically present but not yet usable because too few disks cross a boundary (the "unlock" state, §5.2).

**`AhrPool`** — `{ name, ahrType, mountpoint, disks: [AhrDisk], arrays: [AhrArray], vg: { name, sizeBytes, freeBytes }, lv: { name, sizeBytes }, capacity: AhrCapacity, state, advisories: [string] }`

**`AhrLayoutPreview`** (dry-run, no mutation) — the composer's live feedback: `{ bands: [{ range, memberCount, level, heightBytes, usableBytes, protected: bool }], capacity: AhrCapacity, warnings, minDisksMet: bool }`

**`AhrExpansionIntent`** (the ONLY persisted expansion state — see §5.3) —
`{ id, trigger: 'add-disk'|'replace-disk', approvedDisks: [diskId], replacedDisk?: diskId, replacementDisk?: diskId, before: AhrCapacity, after: AhrCapacity, state: 'running'|'halted'|'done'|'abandoned' }`
- `replacementDisk` pairs with `replacedDisk` (build finding, 11.6): resume of a replace halted *before* the physical swap must know which approved disk substitutes — the pair is intent, not derivable.

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
| `POST` | `/v1/ahr` | Create pool (wipes selected disks); body may carry an optional `mountpoint` override — default `/mnt/anas-ahr/<name>`, never under `/mnt/pve`, never an already-mounted/fstab-claimed path | 202 job / **409 confirm** |
| `POST` | `/v1/ahr/:name/expand/plan` | Compute the expansion plan (before→after) — NO mutation | 200 |
| `POST` | `/v1/ahr/:name/expand` | Execute expansion (add or replace) | 202 job / **409 confirm** |
| `POST` | `/v1/ahr/:name/expand/resume` | Re-run a halted expansion (recompute-and-continue) | 202 job |
| `POST` | `/v1/ahr/:name/expand/abandon` | Abandon a halted expansion intent (pool stays as-is) | 202 job / **409 confirm** |
| `POST` | `/v1/ahr/:name/disk/:id/replace` | Guided single-disk replace | 202 job / **409 confirm** |
| `POST` | `/v1/ahr/:name/disk/:id/readd` | Guided re-add of a returned disk (11.9): per-slice superblock-UUID identity check, `--re-add` differential catch-up via the §2.6 bitmap, stated fallback to full rebuild; refused while reshaping or mid-expansion | 202 job / **409 confirm** |
| `PUT` | `/v1/ahr/:name/mountpoint` | Change the pool's mountpoint — the ONE mutable pool identity (name/tier/arrays are fixed at creation; rename would require offline md superblock rewrites and is deliberately not offered). Same constraints as the create-time override; brief unmount during the move | 202 job / **409 confirm** |
| `POST` | `/v1/ahr/:name/scrub` | btrfs scrub, then md `check` — sequenced, never concurrent | 202 job |
| `POST` | `/v1/ahr/:name/repair` | **Repair from parity** (selfheal.6): body `{ files: [{ path, blocks: [] }] }` — the exact files and 4 KiB blocks the operator picked out of a scrub's findings. Refused while the pool is anything but healthy and idle, while a scrub or another repair is in flight, while a backup holds the pool's top-level mount, and for any path that is not a live file under the mountpoint | 202 job / **409 confirm** |
| `POST` | `/v1/ahr/:name/parity-rewrite` | **Rewrite parity** (selfheal.10): body `{ band }` — recompute ONE band's parity from the data it holds. Refused unless the pool's last COMPLETED scrub — or its last completed REPAIR, whichever is newer — counted a parity mismatch on that band AND left no data unrepaired anywhere (`reason` codes `no-parity-mismatch` / `data-findings-present`), the band is a parity band (`not-a-parity-band`), no member of it carries recorded md bad blocks (`bad-blocks-present`), the band is idle and complete with its sync window at the default (`array-busy`), and no scrub/repair/rewrite is in flight (`job-active`). A guest's LUN live on the pool is DISCLOSED in the confirm gate, never refused — this verb writes parity, never a file. The job runs a FRESH btrfs scrub first and aborts on any finding | 202 job / **409 confirm** |
| `POST` | `/v1/ahr/:name/mirror-reconcile` | **Reconcile mirror** (selfheal.11): body `{ band }` — make ONE RAID1 band's two legs agree again. Refused unless the pool's last COMPLETED scrub — or its last completed REPAIR, whichever is newer — counted a mismatch on that band, recorded it as `raid1`, and left no data unrepaired anywhere (`reason` codes `no-mirror-mismatch` / `not-a-mirror-band` / `data-findings-present`), no leg of it carries recorded md bad blocks (`bad-blocks-present`), the band is idle and complete with its sync window at the default (`array-busy`), and no scrub/repair/rewrite/reconcile is in flight (`job-active`). A guest's LUN live on the pool is DISCLOSED in the confirm gate, never refused — every row this verb writes already matches its stored checksum. No leg is ever failed, removed or re-added, so there is no degraded window | 202 job / **409 confirm** |
| `DELETE` | `/v1/ahr/:name` | Destroy pool | 202 job / **409 confirm** |
| `POST` | `/v1/ahr/:name/cache` | **Attach a read cache** (`ahrcache.1`, §13): body `{disks[]}` — one GPT slice per disk, linear `<pool>-cache` LV, `lvconvert --type cache --cachemode writethrough`. Not confirm-gated (a writethrough cache never holds an only copy). Refuses an offline/failed pool, an already-cached pool, a non-composable disk and a duplicated disk; a rotating pick is LEGAL and earns one advisory sentence on the job result | 202 job |
| `DELETE` | `/v1/ahr/:name/cache` | **Detach the read cache** (§13): `lvconvert --uncache` → `vgreduce` → `pvremove` → `wipefs` → `sgdisk -d`, so the disk reads `available` again (GT-22). Also the operator's RECOVERY verb for a failed cache, and the reclaim verb for a leftover `<pool>-cache<n>` slice a died-and-returned device carries back. Refuses an offline pool with a live cache (uncache needs an active volume) | 202 job |
| `POST` | `/v1/ahr/:name/cache/event` | **The udev auto-uncache rung** (`ahrcache.1` slice 2, §13): body `{event: 'device-removed', slice?, kernel?}`, posted by `/usr/local/bin/anas-cache-event` when a disk carrying a `<pool>-cache<n>` slice is removed. A REPORT, not a command — the verdict is the daemon's own `dmsetup status` read, so the body can never uncache a healthy pool. Runs `lvconvert --uncache` → guarded `vgreduce --removemissing` → `anas-ahr` notification as a job; the leftover slice is deliberately left alone. Idempotent: a second event on an already-uncached pool answers 200 and runs nothing | 202 job / 200 no-op |
| `POST` | `/v1/ahr/:name/remount` | **Remount** (`ahrcache.1` slice 2, §13): `umount` then `mount`, for a filesystem btrfs forced READ-ONLY after an I/O error — `mount -o remount,rw` is refused after an error (GT-20), so this pair is the only recovery. 409 unless `mountedReadOnly`, 409 while the read cache is still `failed` (uncache first), hard 409 while an iSCSI LUN holds the pool, then confirm-gated on the open-handle break. The job VERIFIES the mount came back read-write and fails if it did not | 202 job / **409 confirm** |

**Confirm-gated (Principle 14, the 409 + X-Anas-Confirm-Code flow):** create (wipes disks — lists every disk that will be erased in the warnings), expand/replace (announces reshape duration estimate + the pending-capacity reality), abandon (leaves the pool at reachable-but-not-target layout — states exactly what that layout is), destroy, repair-from-parity (names the snapshot taken, the md knobs turned aside and restored, and what is written), parity-rewrite (names what parity is recomputed from, the fresh scrub that aborts the run, the files it cannot protect, and how long the band will be read), mirror-reconcile (names both arms and their cost, the rows it leaves exactly as they are, that the pool stays online and undegraded throughout, and that md's own repair is neither used nor to be run by hand), and remount (names the open share handles that break, that btrfs refuses `remount,rw` after an error so umount+mount is the only way back, and that a pool read-only again afterwards still has the fault that caused it). The cache verbs are deliberately NOT gated — a writethrough cache holds no only copy, so there is nothing a confirm code could protect. The confirm warnings carry the *concrete* consequence (which disks, how long, how much data at risk), not a generic "are you sure".

**Repair from parity (selfheal.6).** The operator-triggered half of the self-heal epic: `services/selfheal-repair.ts` reconstructs one 4 KiB block from the other members of its stripe, the btrfs checksum arbitrates the candidate, and only a candidate that matches is written back through md. The job runs the picked blocks strictly one at a time — two runs at once would fight over the same `rmw_level`, `sync_min`/`sync_max` and `stripe_cache_size` — and reports every block in one of FIVE honest buckets: `repaired`, `unrepairable` (no source of truth left below the checksum tree — restore the file from backup), `aboveMd` (parity already agreed with the bad data, so nothing was written — the wording implicates something other than the disks, never certainly), `mappingAbort` (the bytes at the mapped location were READ and still pass their stored csum — nothing was written and nothing needs restoring), and `notExamined` (the block was never looked at: an inline extent, a hole, a truncated owner scan, a band whose geometry went unreadable, a read-back guard that says the mapping and the array disagree, or a path whose inode is not the one the scrub examined — its `reasonCode` says which, and the advice is "re-scrub after &lt;what would change&gt;", never a restore and never a clean bill). The five always sum to the blocks attempted. A block whose engine run throws is that block's verdict, never the job's. A block that is repaired and PROVEN while md still counts mismatching stripes on its band leaves a `parityResidual`, reported in `parityResiduals` in the same row shape a scrub's `parityMismatches` uses — the data is right and the parity is what disagrees, so the operator is pointed at Rewrite parity for that band rather than at a restore, and without waiting for a fresh two-phase scrub to rediscover a number this run already measured. A path backing an iSCSI LUN with a LIVE initiator session is refused at the route (`lun-session-active`, no confirm bypass): the block is proven and copy-on-write leaves the old extent alone, but the initiator holds its own cache and has no idea the bytes moved. A member carrying recorded md bad blocks over the target row counts as ABSENT for the reconstruction, exactly as a kicked one does. One PVE notification at the end carries the counts and the per-file outcomes: `warning` when anything is unrepairable or above md, `info` when everything was repaired. The two standing boundaries of the epic hold here: the repair is **never automatic** (an operator asks for it, on named files, with named blocks, through the confirm gate) and it is **never a read-path heal** (nothing repairs a block because someone read it). The UI surface is the Scrubs findings window and nowhere else.

**Rewrite parity (selfheal.10).** The ONE case where ANAS runs `mdadm --action=repair`, and the
only one it can prove safe. md counts mismatching stripes; it never says which member is wrong, and
`repair` resolves that by recomputing parity from the data — so on a DATA-member rot it rewrites
parity to match the junk, the array goes clean, and the rot becomes invisible to every later check
while btrfs still refuses the file (GT-18's negative control). The two cases are indistinguishable
to md and distinguishable to ANAS: a two-phase scrub that counted mismatches on a band AND came back
clean on checksums says the data is right, so the parity is what is wrong. That proof is the verb's
entire licence, which is why the job re-takes it immediately before the md write and runs a FRESH
btrfs scrub of the pool first — the evidence scrub can be hours old, and a finding that arrived
since would be blessed. The sequence is fresh scrub → `mdadm --action=repair` over the whole band →
wait idle → `mdadm --action=check` over the whole band → `mismatch_cnt` must read 0, with one PVE
notification carrying the before/after counts (`info` on `rewritten`, `warning` otherwise). Both md
operations are whole-band with `sync_max` at its default, so nothing narrows a window and nothing
writes `idle`; an operation md took of its own (a member failing mid-run) ends the job with every
knob exactly as md left it. It is never automatic and never pool-wide: one band, through the confirm
gate, with that band's own duration estimate in front of the operator.

**Reconcile mirror (selfheal.11).** The mirror's counterpart, and the one place where md's own
repair is blocked outright. On a RAID1 band `mismatch_cnt` counts legs that disagree with
each other; md does not say which leg is right, and `mdadm --action=repair` resolves that by copying
the first in-sync leg over the other — proven in both directions on the rig (GT-22(f)): with the rot
on leg 0 the junk was propagated to leg 1, and the band then agreed on rotten data where no later
check could see it. So the standing ruling is that **no ANAS code path issues `--action=repair` on a
RAID1 band**, and in `services/ahr-mirror-reconcile.ts` that is a wrapper around the executor rather
than a convention: the guard throws before the process is spawned, on all three of its doors.

The verb has two arms, cheapest first. **Arm A, "scrub until clean":** GT-22's first UNEXPECTED is
that an ordinary btrfs scrub which MEETS a mirror band's rot heals the whole band through md — btrfs
re-reads on a checksum failure, md's read-balance serves the other leg, the good block is written
back, and md propagates that write to BOTH legs. Whether it does is up to a read-balance that is not
contractual anywhere, so the pass is repeated (bounded, three by default) with a whole-band md check
after each; every pass's `corrected` count is progress, and a pass that corrects nothing while md
still counts ends arm A at once — repeating the same coin flip proves nothing. **Arm B, "compare
legs":** both legs are read in full at their OWN data offsets and compared row by row. Each differing
4 KiB row's md byte is mapped BACK to a btrfs logical byte (the chunk-tree hop, inverted) and
arbitrated by the authority the covering chunk names — the stored csum for DATA, the containing tree
node's own header checksum for METADATA and SYSTEM — and the leg that matches is written THROUGH md,
which writes both legs. A row in no chunk is free space, a DATA row with no stored csum is a NOCOW or
prealloc range: both are counted and **left exactly as they are**. A row NEITHER leg can satisfy is
`unresolvedRows` — never written, and reported as a residual with the file to restore.

There is **no degraded window**: no leg is failed, removed or re-added at any point, which is the
whole difference between this and the manual procedure GT-22(b)/(c) documents (a full leg copy at
≈6–7.5 s/GiB with the array single-copy throughout — a day and a half on a 20 TB leg). The one gate
this verb does NOT share with the parity rewrite is the fresh scrub's findings: that verb aborts on
any finding because md repair would bless the rot, and this one writes no row it cannot prove, so a
file neither leg can satisfy is NAMED and the rest of the band is still reconciled. One PVE
notification carries the arm, the counts and the residuals (`info` only when the band came back clean
AND nothing was lost), and it repeats what must not be done by hand.

**Pre-checks:** `expand` REFUSES to start while any array is degraded (reshaping a degraded array voluntarily enters the double-failure window — replace/rebuild first). A replacement disk smaller than the reserved usable size is rejected before any destructive action (§2.5).

**A failed create rolls itself back (issue #11).** Create WIPES the selected disks as its FIRST destructive act, so from that instant the disks contain only what this attempt built — automatic teardown can therefore destroy no operator data, which is what makes it safe here and nowhere else in ANAS. Any failure after that point runs the teardown, then the job fails with the ORIGINAL error annotated `— partial pool was rolled back; disks are blank and create can be retried`; a create is idempotent, so the same request can simply be re-issued. A failure BEFORE the first wipe is propagated unannotated (nothing was touched).

The teardown REUSES `destroyAhrPool` — the same checks-then-acts path the operator's own Destroy takes, which is why it works against a stack built to any depth (no arrays yet, some bands, pinned, PVs-but-no-VG, filesystem-but-not-mounted). It calls the SERVICE, not the route: the 409 confirm gate exists so an operator states intent to destroy data that is theirs, and here the job is cleaning up what it itself built seconds ago on disks the operator already confirmed for wiping. If the rollback ALSO fails, both errors are reported (original first) and the pool stays visible as `failed` for a manual Destroy.

**The operator always learns WHY a create failed**, through three independent channels, because a successful rollback is also the *invisible* outcome — the disks go blank and the pool vanishes from the topology: (1) the job's error, shown by the create dialog while it is still polling; (2) a PVE `warning` notification at failure time, the only channel that survives a daemon restart; (3) a dashboard `ahr` warning card synthesized from the failed job for as long as the daemon lives, since there is no pool left to hang it on. A create that failed and left nothing behind must never be discoverable only by reading job history.

*Known limitation (accepted):* the rollback is in-process. A daemon crash or restart mid-create cannot run it, and the boot scan has no create branch (unlike expansions, which persist an intent). Such a pool surfaces as `failed` with Destroy available — visible and actionable, just not automatic.

**Destroy sweeps by partition LABEL, not only by array membership (issue #16).** Destroy derived its whole wipe list from *current* array membership, so a member that had dropped out of every array was invisible to it — and that is the likeliest state for a disk in a pool being destroyed after trouble. Live on pve5 (2026-08-09): chiaahr2 was destroyed while member d4 was detached from all three bands. The four attached members were blanked; d4 kept all three partitions, live md superblocks and its `chiaahr2-d4-b*` labels, and mdadm's incremental assembly then resurrected ghost inactive arrays from them at the next boot (which blocked the clean re-add with `ADD_NEW_DISK not supported`). Destroy therefore also sweeps every disk the host can see for partitions labeled `<pool>-d<n>-b<band>` — recognized by the exact inverse of the function create writes labels with, so the sweep, create and the topology reader cannot disagree about what a member partition looks like on disk — zeroes their superblocks, and zaps a swept disk's GPT only when that disk carries NOTHING but this pool's members (the same exclusivity guard the ZFS destroy-cleanup path applies: a disk carrying anything else keeps its partition table, and the superblock removal is what closes the ghost-assembly hole). A member disk that is not attached is skipped and **said so** in the job progress and result — never silently, because what cannot be scrubbed comes back with the disk. Sweep failures are reported rather than thrown: a stubborn GPT on a disk that was not even in the destroy target list must not cost the mdadm.conf unpin that follows it.

**Create wipes every fresh md device before LVM touches it (issue #17).** An LVM PV label plus VG metadata live at the md **data offset** — ~128 MiB *inside* the member partitions — deeper than any partition- or disk-level wipe reaches, and `pvremove` can only clear PVs LVM can still SEE (with the bands dead, as in disaster cleanup, it never lists them at all). A recreate with the same deterministic geometry re-exposes the dead pool's labels byte for byte: live on pve5, `pvcreate` refused with *Can't initialize physical volume "/dev/md126" of volume group "chiaahr2" without -ff*. Create therefore runs `wipefs -a` on each array immediately after `mdadm --create` and before `pvcreate`, **unconditionally** — a device ANAS created one command ago can hold nothing but stale residue, so there is nothing to probe first — which makes create immune to this entire resurrection class regardless of what destroy could or could not reach.

**Mixed sector geometries (4Kn + 512e):** an md array inherits `max(logical_block_size)` of its members, so a 4Kn disk that reaches only some bands leaves the pool's bands disagreeing — which LVM refuses by default. Every AHR LVM call (create AND expand) therefore passes `--config devices/allow_mixed_block_sizes=1`; `/etc/lvm/lvm.conf` is never edited (Principle 12 — PVE's own storage runs on LVM). `mkfs.btrfs` states `--sectorsize 4096` explicitly rather than inheriting the CPU page size, which is what keeps the stacked LV satisfied. The planner LABELS a mixed selection in the layout-preview warnings and BOTH confirm gates (create and expand) — the operator learns it before anything is touched, never as a job failure hours into a sync.

*Ground truth (stage test, live 512→4096 under a mounted btrfs):* md inherits `max(member lbs)` at **ASSEMBLY, not at `--add`**. A 4Kn member added to a running 512-byte array leaves that array at 512 until it is next reassembled — both stage arrays came back at 4096 only after a reboot. So the two paths differ in kind:

- **On expand** the mixed window is *transient* — but it spans exactly the `vgextend`/`lvextend` calls, so the flag is still mandatory (a negative control with the flag removed reproduced the refusal).
- **On create** the mix is *permanent* for every band the 4Kn disk does not reach, because those arrays are born with different block sizes.

The stage run passed decisively: 297/297 checksums intact across the transition, clean scrubs, `mismatch_cnt=0`.

*Open item, deliberately not a claim:* while an array advertised 512-byte logical blocks with a 4096-byte member attached, READS were proven safe (O_DIRECT 512-byte reads succeeded, parity check clean). The equivalent **write-path** proof was not captured. Treat this as a watch item on the expand path's transient window, not as a verified guarantee.

*Kernel floor — gate on the KERNEL, never the distro version:* mixed-LBS bands need kernel **6.19+** to assemble (md logs `array will not be assembled in old kernels that lack configurable LBS support (<= 6.18)`). PVE 9 shipped with kernel **6.14.8**, so "any supported PVE qualifies" is false: a fully supported, fully up-to-date node can sit below the floor. Where there is a feature requirement, ANAS checks for the feature's kernel.

The planner therefore takes the running kernel as an input (a value — it never reads the host itself) and:

- **below 6.19 → REFUSES a mixed-LBS layout** with `AhrPlanError`, which every caller already maps to a **400** — so it lands before a confirm code is minted and long before a disk is touched. Behavior of mixed-LBS md creation on a pre-6.19 kernel is unproven, and refusing costs the operator a disk swap or a kernel upgrade where gambling costs them the array. An **unparseable** release fails the same way, deliberately: "we could not establish that this kernel is new enough" must land on refuse for an operation that wipes disks. The message quotes the release verbatim so the operator can tell a bad reading from bad hardware.
- **at or above 6.19 →** the warning carries one factual line: *"These disks require kernel 6.19+ to assemble (this node: 7.0.14-8-pve)."* Naming THIS node's kernel carries the portability fact implicitly — cluster nodes can run different kernels — without a lecture.

Uniform-geometry layouts are unaffected on every kernel. Create and expand get identical treatment through the shared planner.

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
- On power loss mid-reshape, a HEALTHY array resumes on next assembly. **A DEGRADED mid-reshape array does not (GT-8): udev assembles it INACTIVE, all members listed as spares.** Boot/daemon-start detection therefore does more than re-attach monitoring — it runs the verified recovery ladder: `mdadm --run` (starts the array, drops the failed member, lands `active (auto-read-only), clean, degraded`), then `mdadm --readwrite` (reshape resumes from its kernel checkpoint), then `vgchange -ay` once the PV appears. ANAS never re-issues the reshape itself. `reshape-wait` polls `/proc/mdstat` + `mdadm --detail`. Note `auto-read-only` is the normal post-assembly state of EVERY array until first write (GT-9) — not a fault.
- **Ordering safety:** the filesystem is only grown as the LAST step, and only after the LV is confirmed extended. Never grow the fs before the block device beneath it.
- **A new slice must be PUBLISHED, then VERIFIED (issue #12, 0.2.4).** `sgdisk` writes the new band slice to the GPT of a disk that is IN USE — its other slices are live md members — and the kernel refuses the whole-table `BLKRRPART` re-read that would publish it, so `/dev/sdXN` never appears. `udevadm settle` cannot fix that: it drains the udev queue for events that were never generated. The partition step therefore runs `partx -a <dev>` (BLKPG, adds partitions one at a time, needs no exclusive re-read; its "error adding partitions" for already-known ones is expected and ignored), then WAITS for each expected partition to exist as both a kernel device and its `-partN` by-id symlink, and FAILS THE STEP with the real cause if it does not. It never reports the partition step done unverified — that is what turned a partitioning failure into an unrelated error six minutes downstream in `expectedBandMembers`. The CREATE path is immune by construction (it only ever partitions disks it has just wiped, which nothing holds) and keeps the plain `udevadm settle`.
- **Completion invariant (issue #4, 0.2.2):** an expansion is NEVER reported complete — and its intent is NEVER cleared — while any of the pool's arrays still has a sync in flight or queued. md publishes a grown array size only when the reshape ENDS, so every size-dependent step that ran earlier honestly no-op'd against the OLD size. This matters because §5.3 recompute-and-continue plans nothing when a resume is entered mid-reshape (the new disk is already an md member): the executor therefore re-reads /proc/mdstat before completing, WAITS out any sync (never re-issues — §5.1), and then runs the pv → vg → lv → fs tail so it delivers against the new size. The resume planner names the same steps up front so the operator gets reshape progress for the whole (multi-day) wait. A `check` (scrub) is not a hold: it cannot change an array's size. Completion reports the capacity MEASURED on the pool (the LV the filesystem sits on), not the plan's projection, and a shortfall materially beyond the known layout overhead (per-member data offsets + LVM rounding) halts for operator review instead of completing.
- **A step failure halts the pipeline** in a known state; the pool remains whatever it is (usually still mounted and usable — degraded, not down), the intent goes to `halted`, and ANAS reports exactly which layer stopped. The operator's verbs are `expand/resume` (idempotent recompute-and-continue) and `expand/abandon`.
- **Replace uses `mdadm --replace`, never fail-then-rebuild.** When the outgoing disk is still alive (the proactive-upgrade case — the headline use case), `--replace` copies onto the new member while the old one stays in-array, so redundancy is never lost. Fail/remove-then-add would drop every band the disk touches to degraded — voluntarily running the second-failure exposure §7.2 warns about. Fail-then-rebuild is only for disks that are already dead.
- **One replaced disk touches N arrays** (one per band). Rebuild/replace sequencing across those arrays — sequential vs parallel on the same spindle — is a ground-truth decision (parallel likely thrashes; md may serialize on its own; measure it).

### 5.2 Pending capacity ("unlock") — the expansion UX truth

For AHR-1, replacing ONE disk with a larger one yields **zero new usable space** — you need ≥2 disks above a boundary to form a protected array in the new band. The pool enters a state where physical capacity exists (`pendingBytes > 0`) but is locked. Getting this wrong (showing the raw new size as available) is the single most confusing thing hybrid RAID does; ANAS names it explicitly.

**The sentence, and where it comes from.** The planner emits ONE line per pending band — how much is locked, how many more disks of what size it still owes, and what they unlock: *"4 TiB of new capacity is pending — replace one more disk with ≥8 TiB to unlock ~4 TiB."* That line is a plan warning, and the zero-gain refusal below lifts it **verbatim** rather than composing a second description of the same fact. One sentence, one source: the preview and the 409 can never quote different numbers.

**The unlock is modelled the way the plan is shaped.** The headline case is a bay-limited operator upgrading disks one at a time, so a *replace* plan's unlock is another replace: the member count of every band the outgoing disk already served is unchanged, and only the bands above the current top array boundary can form or grow. On the example above that is ~4 TiB (the new [4 TB, 8 TB] band alone) — **not** the ~8 TiB an added fifth disk would give by also widening band 1. An *add* plan states the unlock as another add, and says so in the same sentence ("add one more disk of ≥…"). Both numbers are true; quoting the one that matches the move the operator is already making is what keeps the sentence honest. The count comes from the tier, never from the AHR-1 case: on AHR-2 a fresh band needs four members, so the same shape reads *"replace 3 more disks with ≥8 TiB"*.

**Zero-gain plans are refused up front** (story ahrexpand.1). An expansion whose reachable target adds no usable capacity is a 409 carrying that sentence, not a sub-second "success" that did nothing. The confirm code is the bypass for the honest zero-gain cases — above all the guided replace, which is a *repair* verb: swapping a failing disk for one of the same size is the point of the operation, so that route keeps its own headline ("Replacing disk 'X' in pool 'Y'") and states the zero-gain fact once, as a warning. The headline swap belongs to `ahr.expand`, where growth is the stated intent.

**The gain is measured planner-vs-planner, and a plan with no steps has no gain.** `before` is the band math of the CURRENT layout, never the live volume. A pool whose arrays grew but whose `pvresize`/`lvextend` never ran (the abandoned expansion of §5.3 / issue #13) has a volume smaller than its own band math, and measuring a new plan against that volume hands the new plan the old expansion's owed growth — enough to walk a plan with no steps at all straight past this guard. Both sides being band math over granularity-floored sizes also makes the comparison exact, so it needs no noise-floor margin (unlike `PV_UNDERSIZE_MARGIN_BYTES`, which compares a PV to its device and must stay structural). And a plan that names no steps delivers nothing by construction, whatever the arithmetic says — that is asserted directly, not inferred.

### 5.3 Resume = recompute-and-continue (shadow state minimized, deliberately)

Per the guest philosophy, the *system* is the source of truth: pool topology is reconstructed from `mdadm --detail --scan`, `pvs`/`vgs`/`lvs`, `btrfs filesystem show`, and the GPT partition tables — ANAS does not keep a duplicate registry of what the pool IS.

The draft's open question — can resume be fully stateless? — resolves to **no, but almost**. Pure "drive toward the ideal layout for the current disk set" is unsafe twice over: the fresh-ideal layout is generally unreachable from existing bands (§2.3), and a stateless reconciler cannot distinguish *disk failed* from *disk deliberately removed* — after a failure, the "ideal layout for what's present" is smaller, and driving toward it would destroy data. **A missing disk is NEVER treated as intent.**

**Resume derives its work from truth, not from what the last run did (issue #13, 0.2.4).** §2.3 plans array growth from md state, and pv-resize steps used to ride array-grow steps — so a resume entered AFTER the reshapes finished but BEFORE `pvresize` ran saw arrays already at their target width, planned nothing, and the §5.1 completion invariant then correctly refused to call it done: every further Resume was an identical instant failure with the capacity stranded forever (observed live: PV `PSize` < `DevSize` on the grown bands while the LV and filesystem had only received the new band). Resume now reads the PVs directly — any band whose `pv_size < dev_size` gets a pv-resize step plus the shared vg/lv/fs tail, independent of whether its array needs growing. That is what makes Resume idempotent and self-healing, and it is the same principle as the rest of this section: the plan describes the distance between the system as it IS and as it should be, never the distance from where a previous attempt stopped. The topology reader classifies that stranded capacity as `pendingBytes` ("present, not yet usable"), never `unprotectedWastedBytes` — it sits under full RAID redundancy.

*The under-sized test is STRUCTURAL, never `pv_size < dev_size`.* A healthy, fully-resized PV is always a little smaller than its device — the LVM metadata area at `pe_start` plus physical-extent rounding legitimately eat a sliver. Ground truth (pve5, 2026-08-09, all PVs healthy and fully sized): deltas of **~2.0–4.0 MiB**. A bare comparison therefore fired on every healthy pool, producing the nonsensical *"0 GiB is grown into the RAID arrays but not yet handed up to LVM — resume or re-run the expansion"* on a brand-new pool that had never been expanded. The margin is **1 GiB** (`PV_UNDERSIZE_MARGIN_BYTES`), deliberately an order of magnitude clear of the observed noise: genuine stranded capacity is band-height scale (GiBs to TiBs), and sub-GiB never matters for capacity accounting. One predicate (`isPvUnderSized`) serves both the resume planner and the topology advisory, so the plan and the report can never disagree about what "stranded" means. Same lesson as issue #4's delivered-capacity shortfall margin: LVM/md overheads legitimately eat a sliver, so thresholds must be structural, not zero.

So the persisted state is exactly one small record: the **`AhrExpansionIntent`** — the disk set the operator approved, nothing more. Steps are never persisted; on every run and every resume, the §2.3 planner recomputes the reachable target from (existing bands + the approved disk set) and continues from wherever the system actually is — each step is a detect-then-delta no-op if already done. This is a deliberate, known Principle-11 deviation, minimized to the one fact genuinely not derivable from the system (what the operator intended), mirroring the replication model (systemd units are the store; ZFS state is the truth). Storage location: a small root-owned state file under the daemon's own directory (exact path at build time).

## 6. UI

Reuses `ANAS.gfx` (disk/bay objects, activity strip) and the pool-composer patterns from 3.23.

### 6.1 Create composer (AHR-aware)
- ~~Disk multi-select~~ **Revised (operator, 2026-07-24 — parallel construction):** disk
  selection is **drag-and-drop disk cards, exactly the ZFS vdev composer idiom** (3.23 /
  `38-pool-composer.js`, `ANAS.gfx` drag toolkit) — an available-disks tray of the same
  skeuomorphic disk cards, dragged into the pool bay; AHR needs no vdev arrangement, so
  there is ONE drop target (the planner does the banding — that stays the point).
  Same card contents (icon, labeled size, FULL by-id, never truncated), same
  ineligible-disk treatment as the ZFS composer. An invalid drop (e.g. a too-small
  spare) is refused at the drop with the stated reason. The same drag idiom applies to
  the **expand wizard** (drag disks to add) and **spare attach** (drag a disk onto the
  spare bay). Candidates from `/v1/disks`, excluding ZFS/PVE/mounted/in-use disks, with
  the hands-off tagging already built. Live layout preview updates on every drop/removal,
  as it did on every checkbox change.
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
| Array degraded because md is BUILDING it | *(suppressed)* | issue #14: nothing has failed — journald only |
| Rebuild/recover complete | info | redundancy restored |
| Reshape complete (expansion done) | info | new capacity available / unlock progressed |
| Reshape/expansion FAILED | error | pool stuck mid-transition, needs attention |
| Disk failed DURING reshape | error | reshape continues degraded — combined-risk state (§8) |
| Second disk failure / array failed | **critical** | data loss imminent/occurring; pool may go read-only |
| Pool OFFLINE (a band cannot start, or the LV is inactive) | **critical** | the volume cannot be assembled — data unavailable, not merely unprotected (issue #18) |
| Pool read-only (btrfs forced ro) | **critical** | fs protecting itself |
| Scrub found (and could/could not correct) errors | warning/error | latent corruption surfaced |

**Event discrimination is mandatory, not cosmetic.** mdadm's monitor names things by mechanism, not by meaning, and forwarding it verbatim produces alarming nonsense:

- mdadm calls EVERY sync operation "Rebuild*", so the scheduled parity check arrives as `RebuildFinished` — 11.17 reads `last_sync_action` to say whether a check or a real rebuild finished, and reports mismatches vs bad blocks accordingly.
- mdadm fires `DegradedArray` for any array that STARTS degraded, and it BUILDS RAID5/6 degraded-plus-recovering — so every fresh band of a new pool trips it. Creating a 3-band pool sent three "DegradedArray" alerts within seconds of pressing Create (issue #14, live on pve5). The hook now applies the same discriminator the API state derivation uses (§ issue #9): **zero faulty members, every raid slot accounted for, and a sync actually running** ⇒ journald at `info` with `SYNC=running FAULT=none-recorded NOTIFY=suppressed REASON=no-fault-recorded`, no notification. The record states the observation and stops there (issue #15): this shape cannot tell a first build from a rebuild onto a spare whose dead disk was PULLED, so it must not be logged as an initial build "expected during pool creation". A genuinely degraded start — a MISSING member (dead disk at boot) or a FAULTY one — notifies exactly as before; that path is load-bearing. Unreadable sysfs also notifies: a `DegradedArray` we cannot explain is never silently swallowed.

That rule is implemented twice on purpose — `isBuildingMembership` (TypeScript, from /proc/mdstat) and `initial_build_shape()` (POSIX sh, from sysfs) — because the monitor hook runs with no daemon, no socket and no node. They must be kept in step; each carries a comment pointing at the other.

**Parity-only rot** (scrub, self-heal reporting): phase 1 (md parity check) counting `mismatch_cnt > 0` on a band while phase 2 (btrfs checksum scrub) attributes NO corrupt file is not a false alarm — with every data block passing its checksum, the parity (or Q) member is what disagrees with the data. Nothing in ANAS repairs parity (the repair-verb question is a deliberate operator decision, not a default), so the scrub reports it and says the standing consequence plainly: at the NEXT disk failure in that band, md would reconstruct from the wrong parity. The per-band verdicts ride the scrub result (`parityMismatches`), phase 1's warning promises only what phase 2 can deliver (it checks every file's checksum and names an affected file), and the parity-only case gets its own second notification so the promised attribution never dies in silence.

Routed through PVE's own notification targets/matchers (email/Gotify/etc. the operator already configured) — ANAS emits, PVE delivers. Leverage, not a new alerting system. **Mechanism (GT-17, proven live):** `PVE::Notify::<severity>('anas-ahr', {title, message}, fields)` with ANAS-shipped handlebars templates in `/usr/share/pve-manager/templates/default/` (apt-hook reinstalls after pve-manager upgrades); `fields` carries `type=anas-ahr` for operator matcher rules. **Evaluate first (per 9.4):** does ZED/mdadm's own `MAILADDR`/monitor already cover the disk-failure cases? Wire only the genuinely-missing events; don't duplicate `mdadm --monitor` if PVE can consume it directly.

### 7.3 Dashboard
Only failures and in-progress operations surface (the replication/backup policy): an offline/degraded/failed/read-only pool → warning card (offline/failed/read-only at `critical`); a running reshape/rebuild → the jobs strip with progress. Healthy/idle shows nothing.

## 8. Failure & recovery model

- **Degraded ≠ down**: a single-disk failure in an AHR-1 band keeps the pool fully usable (that's the point). ANAS surfaces it loudly (dashboard + notification) but does not stop service.
- **Reshape interrupted** (power loss): healthy arrays resume automatically on assembly (offset-based reshapes only — §5.1); ANAS re-attaches monitoring, never re-issues the reshape. **If the array was also degraded, it assembles inactive — ANAS drives the §5.1 recovery ladder (GT-8).**
- **Disk fails DURING a reshape** (the scariest real case): md continues the reshape degraded (`clean, degraded, reshaping` — drilled live, GT stage 0, data intact through fail + power-loss + resume). ANAS detects the combined state, notifies at `error` severity, keeps monitoring, and refuses further operations until the reshape completes and the disk is replaced.
- **Step failure**: pipeline halts, intent → `halted`, pool left in a known intermediate state (never fs-mounted-rw during an unsafe block-layer transition); ANAS reports the exact layer + offers Resume (idempotent recompute-and-continue) or Abandon.
- **Disk falls offline and RETURNS** (link reset, cable, controller blip): md marks it faulty → degraded → notifications fire; unlike ZFS's auto-online + DTL resilver, md does NOT reliably auto-rejoin a faulty-marked member. The write-intent bitmap (§2.6) makes the recovery differential; the operator verb is the guided **Re-add** (story 11.9): detect "member faulty, device present and healthy" → `mdadm --re-add` (bitmap fast-path) with fallback to full re-add as a new member, the difference stated in the confirm.
- **btrfs read-only trip**: surfaced as critical; ANAS never force-remounts rw (the fs is protecting data) — points the operator at diagnosis.
- **Marginal replacement disk** (too small by a hair): caught before any destructive action via the §2.5 reserve pre-check, with a clear message.
- **Never btrfs-RAID**: enforced at pool creation — btrfs is always `-d single -m dup` on the one LV.

## 9. Open questions for review

> Stage-0 ground truth (2026-07-22, docs/AHR-GROUND-TRUTH.md) answered several — statuses below.

1. ~~Plan shadow state~~ **Resolved (§5.3):** persist only the approved-disk-set intent; steps are always recomputed. A missing disk is never treated as intent.
2. ~~Replacement reserve granularity~~ **Resolved (GT-16, operator fleet capture 2026-07-22):** modern drives of the same nominal class are byte-identical across vendors/models/interfaces (43-disk sample, zero variance). Floor-to-GiB confirmed as generous insurance; the real hazard is SSD marketing-class mismatch (1000-GB vs 1024-GB "1 TB"), which the §2.5 pre-check rejects explicitly rather than the reserve absorbing.
3. ~~AHR-2 command path~~ **Answered (GT-15):** RAID6 create/grow/double-failure proven live; grow is backup-file-free like RAID5. Planner policy (<4 = wasted) stands.
4. ~~Reshape throttling~~ **Answered (GT-10):** `dev.raid.speed_limit_max` throttles live in both directions; ANAS may offer it during expansions. Sequential-vs-parallel multi-band rebuild on one spindle still unmeasured.
5. ~~Data-offset sizing (§5.1)~~ **Resolved (GT-5 calibrated 2026-07-24):** mdadm's native offset plateaus at 129 MiB (264192 s) for every member ≥ 128 GiB (constant 256 GiB → 15.6 TiB, RAID5 & RAID6); the old 128 MiB pin sat 1 MiB *under* it. Offset consumed per backup-file-free grow is a single bounded ~2 MiB shift, not cumulative (4→5→6→7 held flat after the first). New pin: **256 MiB for members ≥ 128 GiB** (≥ native, generous round, funds unlimited grows), 4 MiB below. Newly created arrays only — existing pools keep their minted offset.
6. ~~Notification overlap~~ **Resolved (GT-11 + operator decision 2026-07-22):** `mdmonitor` runs out of the box; ANAS sets `PROGRAM` in mdadm.conf (surgical edit) pointing at a small ANAS hook that forwards md events to PVE's notification system. Event-driven, zero polling (Principle 7); mdadm covers the md rows of the §7.2 table, ANAS's job layer emits the rest (expansion done/failed, btrfs read-only, scrub results).
7. **Foreign SHR pool adoption (parked, real scope):** because the stack is identical, disks pulled from a dead Synology will likely just assemble as md+LVM on a PVE node. Recognizing/adopting a foreign hybrid pool (read-only rescue at minimum) could be a killer migration story — decide deliberately later; not designed here.
8. ~~mdadm.conf ARRAY pinning~~ **Resolved (operator decision 2026-07-22):** pin, via surgical ARRAY entries (§2.6); code still tolerates both name forms for unpinned/foreign arrays.

~~API home~~ **Resolved:** `/v1/ahr`, sibling of `/v1/pools` — decided with the naming.

## 10. Dashboard integration (§7.3 made concrete — designed 2026-07-23)

The dashboard aggregate gains an AHR source (fail-open like every other source:
an AHR read error degrades the card, never the dashboard):

- **Warning cards** (the §7.3 promise): one card per pool in a bad state, target-first
  per the UI discipline — `offline` (which band arrays cannot start + that the data
  is unavailable), `degraded` (which array/band + member), `failed`,
  `readonly`, and a **halted expansion** (names the Resume/Abandon verbs). A
  consumed spare (§11) and a flat-layout snapshot advisory do NOT card — they are
  view-level advisories only.
- **In-progress**: expansion/rebuild/scrub jobs already ride the shared jobs strip —
  no new surface.
- ~~Healthy/idle AHR pools add NOTHING; no capacity tile in v1~~ **Revised
  (operator, 2026-07-24, after reviewing the live stunt dashboard):** healthy
  invisibility reads as absence, not calm. AHR pools join the dashboard's
  headline Pools section with the SAME structural presence ZFS pools get —
  one block per pool: name + AHR badge + state, capacity (used/usable),
  mountpoint, and the pool → band (raid level × members) → member-disk
  composite in the existing gfx visual language; labeled spare bay when a
  spare is attached; click-through to the Hybrid RAID view. Data: `/v1/status`
  gains `ahrPools` (brief summaries, fail-open `[]` — same contract as every
  source). ~~Live I/O stays ZFS-only for now (`/v1/telemetry` is zpool-based);
  the AHR block renders without an I/O strip rather than showing a wrong
  number.~~ **Superseded (story 11.15, 2026-07-24): the AHR block gets the SAME
  live I/O strip the ZFS block has.** `/v1/telemetry` gains `ahrPools` (same
  IoStats shape as ZFS `pools`, name-matched to the status briefs), derived
  from two `/proc/diskstats` samples ~1s apart — the AHR analog of the
  `zpool iostat` sampling — for the pool's LV (dm device), each band's md
  array, and each member disk (device names resolved at sample time from the
  `/dev/md/<pool>-r<N>` pins and the LV mapper path; point-of-use kernel-name
  rule, never persisted). This gives read/write throughput + IOPS at parity
  with ZFS; **latency is `await` (per-direction tick-delta / io-delta), stated
  honestly as the limit** — diskstats reports the total wait a request saw, not
  the device-service-time split ZFS's `disk_wait` gives. A block with no sample
  yet (first poll pending) still renders WITHOUT the strip — never a fabricated
  zero. `ahrPools` fail-open `[]` independently of the ZFS telemetry. Warning
  cards (above) are unchanged — cards stay failure-only.

## 11. Hot spares (designed 2026-07-23)

**Model:** pool-level spares. A spare must cover EVERY band — usable (rounded)
size ≥ the pool's top array boundary; a partial spare is refused with the exact
shortfall (a spare that can't absorb every failure is a false promise). Multiple
spares are allowed; each is full-coverage.

**Mechanics:** the spare disk is wiped and partitioned with the pool's full
band-slice geometry (§2.6 rules, ghost-clearing pass included), then each slice
is `mdadm --add-spare`'d to its band array. From there **md owns the failover**:
a member failure triggers an immediate automatic rebuild onto the spare slice —
no operator, no daemon, no polling (Principle 7). mdmonitor's `SpareActive` /
`RebuildFinished` events flow through the existing hook.

- **Topology:** spare slices show as mdstat `(S)` members; the disk reports
  `role: 'spare'`. Spare capacity is EXCLUDED from `rawBytes` (it contributes no
  usable bytes; the UI shows a labeled spare bay instead).
- **After a failover** the spare has become a member. The pool advisory states
  it plainly ("spare consumed by band N — add a new spare; remove/replace the
  failed disk"). Adding the next spare first `--remove`s any faulty slots whose
  device is ABSENT (slot hygiene); a faulty-but-present disk stays untouched —
  that is Re-add's (11.9) or Replace's job.
- **Expansion coupling:** a new band created by expansion automatically extends
  every attached spare (partition the new slice + `--add-spare`) as part of the
  `array-create` step — a spare never silently loses coverage. If a spare
  cannot cover a new, taller top band, the expansion PLAN warns before confirm
  (the spare keeps covering existing bands; the advisory names the gap).
- **API (§4):** `POST /v1/ahr/:name/spare {diskId}` (409 confirm — the disk is
  wiped) and `DELETE /v1/ahr/:name/spare/:id` (409 confirm — protection
  headroom drops; slices removed from every array, disk zapped).
- Promote-spare-to-member and shared spares across pools: OUT of v1.

## 12. Snapshots — btrfs subvolume layout (designed 2026-07-23)

**Layout decision:** NEW pools are created with a subvolume layout —
`mkfs.btrfs` → mount the top-level briefly → `btrfs subvolume create @data` and
`@snapshots` → remount with `subvol=@data` at the pool mountpoint (fstab
carries the option). The operator sees exactly what they saw before; snapshots
live OUTSIDE the mounted tree, so they never nest into the data and rollback is
a subvolume swap. Pools created before this design (flat layout) report
`subvolLayout: false` + an advisory — snapshots unavailable; **no migration
verb** (moving data across subvolume boundaries is a copy; the only pre-design
pools are throwaway test pools — destroy/recreate is the migration).

**Operations** (top-level mounted on demand at a private runtime path,
unmounted after each op — nothing new stays mounted):

| Verb | Semantics |
|---|---|
| `GET /v1/ahr/:name/snapshots` | list (`btrfs subvolume list -s`, otime, readonly flag) |
| `POST /v1/ahr/:name/snapshots {name?}` | read-only snapshot of `@data` → `@snapshots/<name>`; default name = UTC timestamp; charset-safe names | 202 job |
| `DELETE /v1/ahr/:name/snapshots/:snap` | `btrfs subvolume delete` | 202 job / **409 confirm** |
| `POST /v1/ahr/:name/snapshots/:snap/rollback` | **409 confirm**; brief unmount of the pool; current `@data` is PRESERVED as `@snapshots/pre-rollback-<ts>` (rename — instant), the chosen snapshot becomes the new writable `@data`, remount. Nothing is destroyed by a rollback, ever |
| 202 job |

- **Transient repair pins:** the self-heal engine takes its cold read through a
  read-only snapshot named `anas-selfheal-<ts>` (under `@snapshots` on §12
  pools; inside the served tree on a flat pool) and deletes it in its `finally`
  — a leftover from a failed cleanup shows in the Snapshots manager labelled
  "transient — ANAS repair pin; safe to delete if no repair is running", and is
  never offered as a rollback target.
- **Schema:** `AhrSnapshot { name, createdAt, readonly }`; `AhrPool` gains
  `subvolLayout: boolean`. Snapshot sizes need qgroups — OUT of v1 (never show
  an unlabeled or wrong number).
- **UI:** a `Snapshots…` button on the Hybrid RAID **grid toolbar** (selection-
  dependent, disabled with the advisory on a flat pool) → manager window (list,
  create, delete, rollback — rollback confirm states the unmount + the
  auto-preserved pre-rollback snapshot). Mirrors the datasets snapshot idioms.
  *(2026-08-19: moved off the Details window — actions live on the grid toolbar,
  the detail window is display, per the Pools view.)*
- **Follow-ups inked, not built here:** Epic 16 snapshot-consistent backup for
  AHR sources (snapshot → back up `@snapshots/<x>` → delete, exactly the ZFS
  treatment); Epic 17 scheduled snapshots + scrubs gain AHR targets.

## 13. Read cache — lvmcache writethrough (designed 2026-09-21, GitHub #63)

**Shape.** The pool VG already carries the concatenation layer, so the cache sits
where LVM expects it: one GPT slice per cache disk (by-id convention as for band
slices) → `pvcreate` → `vgextend <pool>` → `lvcreate -n <pool>-cache` (linear
across all cache slices — a writethrough cache is never the only copy, so it
needs no redundancy) → `lvconvert --type cache --cachevol <pool>-cache
--cachemode writethrough <pool>/<pool>-vol`. Policy `smq` (kernel default;
sequential I/O bypasses). The pool LV keeps its name and mapper path, so
mounts, shares, LUNs and the fstab line are untouched. Detach = `lvconvert
--uncache` (drops the cache volume) → `vgreduce` → `pvremove` → wipe the slice.
**Writeback and `--type writecache` are not exposed** (EPICS §2 ruling).

**Steps** join the §5.1 executor as detect-then-delta kinds: `cache-attach`
(partition → pv-create → vg-extend → lv-create → lv-convert) and `cache-detach`
(uncache → vg-reduce → pv-remove → wipe). Attach/detach are jobs on an existing
pool; the create composer does not offer a cache.

**Ground truth (2026-09-21, stunt node, lvm2 2.03.31-2+pmx1, loop devices):**
- `lvextend` on the cached origin succeeds while mounted (`vol_corig` grows,
  the cache LV reports the new size) and `btrfs filesystem resize max` follows —
  the §5.1 expansion pipeline needs no split/reattach around a cache.
- `lvs --reportformat json` exposes `cache_mode`, `cache_policy`,
  `cache_total_blocks`, `cache_used_blocks`, `cache_read_hits/misses`,
  `cache_write_hits/misses`, `cache_dirty_blocks`; hidden sub-LVs appear as
  `[<pool>-vol_corig]` / `[<cache>_cvol]` under `lvs -a`. Structured — no parsing.
- **Cache PV missing at activation: refused** (`Refusing activation of partial
  LV`) in normal AND `--activationmode degraded`; `partial` fails on the missing
  cache metadata. Recovery = `lvconvert --uncache <pool>/<pool>-vol` (works with
  the device absent, no `--force`) → `vgreduce --removemissing <pool>` →
  `vgchange -ay` → data reads back intact. Dirty blocks are zero by construction
  in writethrough, so this is safe to run unattended.

**Boot rung (ahr-boot-scan):** cache PV missing → run the recovery above → pool
mounts uncached → notification + dashboard `ahr` warning "cache device missing,
pool running uncached". Parallel to an md array assembled degraded-but-running.

**Topology:** a PV in the pool VG that is not an md array is classified `cache`
(today every PV is expected to be `/dev/md/<pool>-r<band>`); the cache disk is
in-use with role `cache` and excluded by `isComposableDisk()` from composer,
spare and expand candidates; destroy adds the cache slice to the wipe list.
Verify the 11.15 telemetry sampler's dm-name resolution once the pool LV is a
`cache` target (dm-0 is then the cache device, the origin is a hidden LV).

**Pool detail `cache` block:** devices (by-id), size, mode (always
writethrough), hits/misses, used/total blocks, dirty blocks (should read 0 —
non-zero is a bug). **Wear: the Disks tab (SMART), not repeated here** — wear
is a per-disk fact the disk inventory already owns (`disks.1`), and a second
rendering of it in the Cache block is the same number in two places, free to
diverge. One place. Advisory states two facts once: hotspot cache
(repeated random reads benefit, sequential I/O bypasses), and the SSD is a
consumable (cached blocks are rewritten as the working set rotates).

**Resolved 2026-09-24 (GT-18…GT-24, `AHR-GROUND-TRUTH.md` §18).** (a) **dm-cache does NOT
bypass a dead cache device** (GT-19): every read on the pool returns EIO within the
second, promoted or not; btrfs stays read-write under a pure read load and flips to
forced read-only on the first write (`aborting current metadata transaction`). The
§13 recovery is the whole repair and it is live: `lvconvert --uncache` succeeds with
the device absent and the pool mounted, no `--force`, in ~0.25 s, and reads recover on
the next I/O (GT-20); `vgreduce --removemissing` then drops the ghost PV. What it
cannot undo is btrfs's forced-readonly flag: `remount,rw` is refused after an error,
only `umount` + `mount` restores writes. **Design calls:** the daemon uncaches
AUTOMATICALLY on detection — unattended-safe by construction (dirty = 0) and it
restores reads instantly — through an EVENT, never a poller: a udev rule on the
cache disk's removal (the `anas-md-event.sh` pattern) calls the daemon, which reads
`dmsetup status` (the ONE honest health signal — `lvs` counters go STALE, not
absent, on a dead cache) and runs uncache → vgreduce → notification
("cache device <id> failed; pool <p> running uncached"); the boot rung does the same
at activation; every AHR status READ also reports the truth from `dmsetup status`
(`cache: failed` ⇒ pool `degraded`, warning card) — today it reports `healthy` with
the pool unable to serve a byte (GT-23), the load-bearing fix. If btrfs went
read-only, the pool detail says so and offers **Remount** (unmount + mount, an
operator verb: open share handles break, refused while a LUN holds the pool); the
notification names both facts. A cache disk that RETURNS carries an outdated PV label
(`WARNING: outdated PV … seqno`); the repair and the next attach wipe it. (b) **A cache
slice on an idle disk publishes immediately** with `sgdisk` + `udevadm settle`, the
create path's pair — the issue-#12 retry dance is a holders problem, not a cache one
(GT-21; `partprobe` is not installed on PVE 9). `cache-attach` needs `wipefs -a` on
the slice before `pvcreate` (a stale signature makes `pvcreate` abort non-
interactively) and `lvconvert -y`. `cache-detach` must DELETE the partition
(`sgdisk -d` / `--zap-all`), not merely `pvremove` + `wipefs`, or the disk keeps
reading `other` instead of `available` (GT-22). **Consumers:** the cache disk is
`in-use`, role `cache`, attributed to its pool (today `other`, unattributed — safe by
accident since `isComposableDisk()` admits only `available`); `vg.sizeBytes` includes
the cache slice — capacity derives from the LV, never the VG (audit the consumers);
telemetry (11.15) keeps resolving `dm-0` but the pool row legitimately exceeds the sum
of its bands by the cache hits (GT-24) — the pool-detail `cache` block is where the
difference is shown, and its counters are gated on `dmsetup status` not reading
`Error`. Policy wording: `lvs` is truth for mode/policy (`smq`; the "sequential I/O
bypasses" note was an `mq` property and is dropped), `dmsetup status` is truth for
health.

**Built 2026-09-24 — slice 1** (shared `cache` block + `AttachAhrCacheRequest`,
the two executor step kinds, `POST`/`DELETE /v1/ahr/:name/cache`, the
`dmsetup status` health read on every AHR read, the `cache` disk role; live-proven
on the stunt node, spec `tests/integration/ahr-cache-api.spec.ts`). Three
refinements the build measured, all recorded in GROUND-TRUTH §18: the failure
word is `Fail` as often as `Error`, so health is decided structurally (a real
dm-cache status line opens with a digit) rather than by matching a word;
`dmsetup status <name>` prints its target line without the `<name>: ` prefix the
bare listing uses; and a LEFTOVER `<pool>-cache<n>` slice — what a
died-and-returned cache device carries back — keeps its disk attributed to the
pool, so both verbs accept it: attach reuses and re-wipes the slice, detach
deletes it and hands the disk back. Slices 2 (the udev auto-uncache rung, the
boot rung, Remount) and 3 (the UI) are the rest of the story.

**Built 2026-09-24 — slice 2 (the failure path).** Four rungs, all at UNIT
level; the live-proof spec is WRITTEN and its first run is the story's proof.
(1) **udev auto-uncache.** `packaging/anas-cache.rules` →
`/etc/udev/rules.d/99-anas-cache.rules` fires on the REMOVE of a block
partition whose `ID_PART_ENTRY_NAME` matches `?*-cache[0-9]` (and the
two-digit form) — the GPT label attach itself writes. A band member's slice is
`<pool>-d<n>-b<m>` and can never match it, so a pulled pool disk stays mdadm's
event and reaches ANAS through `anas-md-event` as before. The rule runs
`/usr/local/bin/anas-cache-event` (the `anas-md-event.sh` pattern one level up:
md's hook only logs and notifies, this one has a repair to run), which derives
the pool from the label, journals under the `anas-ahr` tag and POSTs to
**`/v1/ahr/:name/cache/event`** over the root-only socket with the
`x-anas-user: system:udev-cache-event` identity headers — the socket is the
trust boundary, exactly as for the systemd task runners. The script decides
NOTHING and runs no storage command: the verdict is the daemon's own `dmsetup
status` read, so the body cannot uncache a healthy pool, and a daemon that is
not running costs a DELAYED repair rather than a lost one (the boot rung runs
the same recovery at the next start, and the journal says so). The endpoint
runs `recoverFailedAhrCache` as a job — `lvconvert --uncache` → guarded
`vgreduce --removemissing` → one `anas-ahr` notification — and is idempotent: a
second event on an already-uncached pool answers 200 and runs nothing, which
matters because udev re-runs rules. The recovery is deliberately NARROWER than
detach: it never wipes or deletes the `<pool>-cache<n>` slice, because that
slice is what keeps a died-and-returned disk attributed to its pool and
Reclaim reachable. (2) **Boot rung** — `ahrBootScan` branch (d), gated on ONE
`lvs` call (most starts have no cache at all, and the topology read is a dozen
commands): a pool whose `cache.state` reads `failed` gets the same recovery,
then `vgchange -ay` and the fstab `mount`, in that order, so a pool never comes
up serving EIO. It runs AFTER the (a) md ladder on purpose — the
`--removemissing` guard needs the band arrays present to tell a dead cache from
an unassembled band. A healthy cached pool is untouched; a guard refusal
notifies `error` and never takes the daemon down. (3) **`POST
/v1/ahr/:name/remount`** — `umount` then `mount`, never `remount,rw` (GT-20:
btrfs refuses it after an error). 409 unless `mountedReadOnly`, 409 while the
cache still reads `failed` (remounting over a dead cache lands a filesystem
that cannot serve a byte), hard 409 under a LUN, then the confirm gate naming
the open-handle break. The job verifies the mount came back read-write and
FAILS if it did not. (4) **`mountedReadOnly`** on the pool payload, separate
from `state: 'readonly'` because the state ladder lets `failed`/`offline`
outrank it and a UI gating Remount on the badge would hide the verb exactly
when it is needed; the read-only advisory and the dashboard card now share ONE
clause that names Remount and says writes are stopped until the pool is
remounted. The UI verb itself is a small follow-up (the `39-ahr.js` comment
marks where it goes).

**Fix batch (review, 2026-09-24).** DESTROY must uncache before `lvremove`: a
cached pool's LV is a dm-cache target and `lvremove` refuses one, which stopped
the teardown with the pool already unmounted and its fstab line gone while the
VG, LV and arrays still stood. It runs the detach step's own `lvconvert
--uncache` first, and the confirm warnings name the cache disks and say they
come back available. Four more calls, all in the same spirit: both verbs refuse
through the job queue while a cache job is already in flight on the pool (the
repair/scrub pattern — the queue runs four jobs at a time and a second attach's
rollback would uncache the first's live cache); `vgreduce --removemissing` is
taken only when every band already has its own named md PV, because a stopped
band array reads `[unknown]` exactly as a dead cache device does; detach's
`vgreduce` names only PVs sitting on a disk that carries one of our
`<pool>-cache<n>` slices, so a PV an operator added to the VG by hand is left
alone; and a cache-target LV whose `dmsetup status` cannot be read reports
`failed`, never `absent` — an unreadable health signal is not "there is no
cache". Detach on an offline pool is refused up front with the reason (uncache
needs an active volume), a rollback that itself fails is logged to the journal
with the pool and the step while the original cause is still what is thrown,
and a duplicated disk in the attach request is a 400.

**Built 2026-09-24 — slice 3** (the pool detail's Cache block, the **Attach
cache…** / **Detach cache** toolbar verbs with the advisory and the confirm;
`packages/pve-integration/src/39-ahr.js`, proven in the dialog-contracts
harness, Playwright spec `tests/integration/ahr-cache-ui.spec.ts` written).
Two calls the UI leg settled:

- **Detach's confirm is a plain `Ext.Msg.confirm`.** The route stays
  un-gated — a writethrough cache holds no only copy, which is what a confirm
  code is for — but a 202 verb that wipes a consumable SSD still earns a
  click-through. This is the distinction `ANAS.confirmAndRun` does NOT make:
  that helper only ever opens its dialog from the daemon's 409 challenge, so
  pointing it at a 202 route runs the verb on the first click with the confirm
  text a dead string. Un-gated destructive verbs take the plain-confirm idiom
  (`60-datasets.js`, `69-snapshots.js`, `75-iscsi.js`); the harness guards the
  rule generically by resolving every `confirmAndRun` in the AHR view to its
  daemon route and requiring that route to gate.
- **The cache disk is not band geometry.** It is excluded from the banded-layout
  bars, from the "capacity above the top band" test that draws the unprotected
  pseudo-band, and from the scale the per-disk slice bars are drawn against —
  `diskInBand()` is a pure size test, so a cache SSD taller than the members
  would otherwise be painted with bands it holds not one byte of and would
  manufacture a "wasted" band out of flash that is doing its job. Hot spares
  STAY in all three: a spare is cut to the band geometry and really carries it.

