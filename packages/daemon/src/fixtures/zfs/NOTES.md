# ZFS fixtures — provenance

The "ground truth first" ruling asks every fixture to be labelled **real capture** vs
**synthetic**. This directory predates that labelling, so this file states what is known
about each group rather than pretending it was always recorded.

## Real captures

Captured on **2026-08-25** for story **iscsi.3** on the stunt node (`anas-pve`,
192.168.200.50) — a disposable PVE 9 VM running `zfs-2.4.3-pve1` / `zfs-kmod-2.4.3-pve1`
on kernel `7.0.14-12-pve`. Nothing here comes from a production host. Both files are
verbatim daemon stdout, re-indented by `python3 -m json.tool --indent 4` and nothing else
— no values were edited, added or removed.

| File | Command | What it proves |
|------|---------|----------------|
| `zfs-list-volumes.json` | `zfs list -j -r -o name,used,available,referenced,quota,mountpoint,compression,compressratio,type,volsize,volblocksize,refreservation -t filesystem,volume gtiscsi` | A real pool carrying a filesystem, a nested filesystem and a **real zvol** side by side — the exact columns `ZFS_LIST_PROPS` asks for. |
| `zfs-get-volume.json` | `zfs get -j all gtiscsi/vol1` | The complete property bag of a **real zvol**: 48 properties. |

What these two captures settle for `iscsi.3` (each was a guess before):

- A volume's `zfs list` row reports `mountpoint`, `quota`, `volsize` and `volblocksize`
  as literal `"-"` where they do not apply — so `"-"` must be read as *absent*, never
  parsed as a size. On the volume row `volsize` is `2G` and `volblocksize` is `16K`.
- `zfs get all` on a volume **does not emit `mountpoint`, `quota`, `recordsize` or
  `atime` at all** — those properties simply do not exist on a zvol. That is the
  evidence behind the create schema refusing `mountpoint`/`recordsize`/`quota` for
  `type: 'volume'`, and behind the UI disabling the filesystem-property editor on a
  volume row.
- The volume is **thick**: `refreservation` is `2.03G` with source `LOCAL`, and `used`
  (2.03G) is the refreservation rather than what was written (`referenced` is 60.5K).
  This is why `sparse` is derived from `refreservation` and why a thick volume never
  shows reclaim in `used`.
- `volblocksize` carries `source.type: "DEFAULT"`, which is the only honest place to
  read **ZFS's own default block size** from — there is no module parameter for it
  (checked: `/sys/module/zfs/parameters` has no such knob). `parseVolblocksizeDefault`
  reads it straight out of the list output, so stating the default in the Create dialog
  costs no extra command.

No sparse volume existed on the stunt node and the story's read-only rule forbade
creating one, so the thin case is exercised by mutating this real capture's
`refreservation` to `none` inside `zfs-list.test.ts` — done in the test, and named
there, rather than checked in as a fixture that looks captured but is not.

## The `-p` flag and these captures (issue #50, 2026-09-03)

`zfsListArgs` now issues `zfs list -j **-p** -r -o …`. Without `-p` every number
in the JSON is the DISPLAY form — three significant digits — and the volume
never-shrink gate was comparing a requested exact byte count against it, so a
real shrink inside the rounding window read as a grow (`1.21T` → 1,330,409,069,609
against a true 1,331,439,861,760: ~983 MiB light).

**Both `zfs list` files here therefore predate the command we now issue.** They
are deliberately kept **verbatim** rather than mechanically rewritten:

- `zfs-list-volumes.json` is a real capture. Its exact byte counts are NOT
  recoverable from the rounded strings it holds (`2.03G` is anything in
  [2.025 G, 2.035 G)), so "converting" it would mean inventing digits and
  checking them in under a heading that says *real capture*. That is exactly the
  thing ground-truth-first forbids.
- `zfs-list.json` is synthetic and mixed-purpose: the same file feeds the `-p`
  dataset list AND the snapshot parsers, whose commands stay in display form
  (`creation` under `-p` is an epoch integer `parseZfsDate` does not read).
  Rewriting it would make one of its two jobs wrong.

Instead, `parseHumanSize` reads **both** forms (it has to: `zfs get -j all` and
the snapshot listings are still display-form on purpose), the `-p` rows are
DERIVED inside the tests and named as derived — the same rule the thin-volume
case above already follows — and these two files now serve as the display-form
tolerance cases.

**Owed:** a fresh `zfs list -j -p -r -o <ZFS_LIST_PROPS> -t filesystem,volume
<pool>` capture from a real node, to be checked in beside the existing one
(suggested name `zfs-list-volumes-p.json`) and to settle two things nothing here
can attest to: whether libzfs emits `-p` values as JSON strings or numbers (the
parser accepts both), and whether `compressratio` keeps its trailing `x` under
`-p` (`parseDedupRatio` accepts both).

## Pool-shape zoo (topology.1)

The 0.3.5 post-mortem ruling (b) asked for one documented zoo of pool shapes: every
`zpool-status-*.json` here plus the matching `zpool-iostat-plv*` captures under
`../telemetry/`, each row stating what the file IS and what layout facts it pins. A
parser test iterates the zoo (`parsers/__tests__/zpool-status-zoo.test.ts`) and fails
by fixture name when a parser change drops a section or shifts the output shape, so a
row below is a contract, not a description. One command produced each status file:
`zpool status -jv` (the argv the daemon issues); the iostat files are
`zpool iostat -plv <pool> 1 2`.

Provenance comes from each file's own git history (`git log --follow`) and its
`_comment` where it has one — never from inside the JSON. March 2026 captures are from
the stunt node of that period (PVE 9, "ZFS 2.4" per the capturing commit); the
`*-2.4.4` files are verbatim daemon stdout from the current stunt node (PVE 9.2.20,
`zfs-2.4.4`, 2026-09-24, the vdevs.1/vdevs.2 ground-truth sessions). One cross-fixture
fact the zoo exposed: the older files quote `pool_guid` (a JSON string), the 2.4.4
captures emit it UNQUOTED (libzfs's uint64) — the parser passes it through verbatim, so
`guid` is number-typed on exactly the real 2.4.4 captures. For files added
with a feature commit and without a recorded capture, provenance is stated as
**unrecorded** — read them as capture-shaped until a capture replaces them, not as
evidence about how ZFS behaves.

| File | Pool (state) | ZFS | Captured | Layout facts pinned |
|------|--------------|-----|----------|---------------------|
| `zpool-status-online.json` | `testpool` (ONLINE) | 2.4 | 2026-03-15 (`6cc715e`), then rewritten by hand (`45f153a` "richer mock data") | Two `mirror-N` data vdevs + a pool-level `spares` section; leaves by-id **partitions** (`-part1`) with `devid` and `phys_path`; a FINISHED scrub record. The second mirror and the WD serials are mock (the serials `WD-12345678`/`WD-56789012` are invented) — treat the mirror count, not the drive identity, as the pinned fact. |
| `zpool-status-online-fresh.json` | `testpool` (ONLINE) | 2.4 | 2026-03-16 (`b264078`, story 3.16) | Single mirror; **no `scan_stats`** at all — the "none requested" shape. |
| `zpool-status-degraded.json` | `testpool` (DEGRADED) | 2.4 | 2026-03-16 (`b264078`) | Mirror with an **OFFLINE** leaf (admin offline); pool `status`/`action`/`msgid` health block; no scan record. |
| `zpool-status-degraded-removed.json` | `testpool` (DEGRADED) | 2.4 | 2026-03-16 (`b264078`) | Mirror with a **REMOVED** leaf (disk yanked); FINISHED resilver retained. |
| `zpool-status-degraded-offline.json` | `testpool` (DEGRADED) | 2.4 | 2026-03-16 (`b264078`) | The offline-leaf sibling of the above with its own FINISHED-resilver record. |
| `zpool-status-suspended.json` | `testpool` (SUSPENDED) | 2.4 | 2026-03-16 (`b264078`; all disks yanked) | Pool **SUSPENDED** with `ZFS-8000-HC` health block, `error_count: 4`, per-leaf error counters non-zero, the old resilver record still carried. Pre-dates `-p` and the zoo; the suspended capture the story owes is re-taken under 2.4.4 (below). |
| `zpool-status-suspended-verbose.json` | `testpool` (SUSPENDED) | 2.4 | 2026-03-16 (`b264078`) | The `-v` form of the same shape: **`errlist`** present (error detail beyond the count). |
| `zpool-status-raidz.json` | `testpool-rz` (ONLINE) | 2.4 | 2026-03-16 (`b264078`) | One `raidz1-0` with three disk leaves; no scan. |
| `zpool-status-raidz-degraded.json` | `testpool-rz` (DEGRADED) | 2.4 | 2026-03-16 (`b264078`) | raidz with a REMOVED leaf; FINISHED scrub retained. |
| `zpool-status-resilvering.json` | `testpool` (ONLINE) | 2.4 | 2026-03-16 (`b264078`) | FINISHED **RESILVER** (`processed` = the repaired bytes ZFS prints). |
| `zpool-status-scrubbing.json` | `testpool-rz` (ONLINE) | 2.4 | 2026-03-16 (`b264078`) | **SCANNING** scrub: `end_time` unset, `finishedAt` null. |
| `zpool-status-scrub-verdicts.json` | `repairpool` + `cancelpool` (ONLINE) | — | 2026-08-17 (`6042272`, story 17.3) — **canonical forms, NOT captures** (its own `_comment` says so; producing repaired/canceled verdicts live would damage a pool) | A FINISHED scrub that repaired `1.50M` with 2 errors; a **CANCELED** scrub (its zero errors must never read as a clean bill); a single whole-disk by-id leaf (`ANAS_C3`, no `-partN`). |
| `zpool-status-with-spare.json` | `testpool` (ONLINE) | 2.4 | 2026-03-16 (`04a8aca`) — provenance **unrecorded** | A healthy mirror + an **AVAIL** spare in the pool-level `spares` section (QEMU stunt-node naming). |
| `zpool-status-spare-active.json` | `testpool` (DEGRADED) | 2.4 | 2026-03-16 (`04a8aca`) — provenance **unrecorded** | ZFS's **activated-spare** shape: the data mirror carries a `spare-1` vdev (failed leaf REMOVED, spare ONLINE) while `spares` still lists the spare **INUSE**; the same disk appears in both places. |
| `zpool-status-all-vdev-classes-2.4.4.json` | `gt66` (ONLINE) | 2.4.4 | 2026-09-23/24, stunt node (vdevs.1 GT) | One pool, **all six classes**, one partition each, **kernel names** (`sdb1`–`sdb6`, no by-id anywhere — the CLI-built shape); all five pool-level sections (`logs`, `l2cache`, `spares`, `special`, `dedup`) beside the tree. |
| `zpool-status-mirrored-log-partitions-2.4.4.json` | `gtbackup` (ONLINE) | 2.4.4 | 2026-09-23/24, stunt node (vdevs.1 GT) | **File vdev as the data root** (`vdev_type: "file"`, `/var/tmp/gtbackup.img`); a **mirrored log inside the `logs` section** (`mirror-4` with two partition leaves); a bare disk cache. KNOWN QUIRK it pins: the in-tree file vdev parses with **zero leaves** — only pool-level bare entries become leaves — which is exactly the shape the missing file-vdev capture below will re-examine. |
| `zpool-status-multi-cache-spare-2.4.4.json` | `gtvdev` (ONLINE) | 2.4.4 | 2026-09-24, stunt node (vdevs.1/.2 fix batch, `c10b976`) | **By-id partitions of ONE disk** for every class; `l2cache` with **two** bare leaves and `spares` with **two** (the multi-entry sections that fold into one container vdev each); single-leaf `logs` takes the same container shape. |

The iostat half of the zoo lives beside its parser fixtures in `../telemetry/` (each
row there in `../telemetry/NOTES.md`); the pairs:

| File (under `../telemetry/`) | Pairs with | Pinned |
|------|------------|--------|
| `zpool-iostat-plv.txt` | synthetic `testpool` — **not a capture** (pre-labelling) | The base two-sample layout (`1 2` = since-boot + interval), tree depth by indentation. |
| `zpool-iostat-plv-all-vdev-classes-2.4.4.txt` | `zpool-status-all-vdev-classes-2.4.4.json` (pool renamed `gt66` → `gtvdev` when paired) | The vdev-class section headers print **UNINDENTED in the pool column, every cell `-`**; devices at the vdev indent; **a spare prints no row at all**. This is the capture behind the all-dash header rule. |
| `zpool-iostat-plv-multi-cache-spare-2.4.4.txt` | `zpool-status-multi-cache-spare-2.4.4.json` | By-id **partition** leaves at the vdev indent under the section headers — long names, two leaves per section. |

Also captured by the 3.16 session and feeding the same parsers: `zpool-list-raidz.json`
(the `testpool-rz` capture of `zpool list -j`).

### Missing shapes

The four captures the story names as still missing, each with the
`test/stunt-node/vdev-fixture.sh` verb that will produce it
(`test/stunt-node/topology-zoo.sh capture` runs the sequence and lands the files
here / in `../telemetry/`). Until a capture exists, no fixture file for that shape is
checked in and no test cites one — the zoo test skips the pair.

| Missing shape | Verb | What the capture settles |
|---------------|------|--------------------------|
| File vdevs (a dedicated file-vdev pool; file-backed `cache`/`spare` section entries) | `up-file` — files under the `gtbackup` dataset | Whether the in-tree file vdev should carry a leaf the way a section entry does (the `gtbackup` quirk above), and that a `vdev_type: "file"` cache/spare keeps its leaf. |
| A by-id **whole-disk** pool (leaves by-id with no `-partN`) | `up-byid-whole` — disk 9's whole disk by-id | The leaf identity/path shape of the most common production layout (`zpool create` on `/dev/disk/by-id/<disk>`), beside the partition-backed shapes already captured. |
| A suspended pool's `zpool status -j` under the current ZFS build | `up-suspended` — a pool on a dm-linear device over a file under `/gtbackup/anas-topology-zoo`, whose table is swapped to **dm-error** so every I/O fails and the pool suspends (ZFS holds a file or loop device OPEN, so removing or truncating the backing does not fail the I/O — the dm swap does, deterministically, the way the yanked-disk capture of story 3.16 did) | Re-takes the March capture under ZFS 2.4.4 with the `-p` argv the daemon actually issues (the existing `zpool-status-suspended*.json` pre-date both). |
| A suspended pool's `zpool iostat -plv` | `up-suspended` (same pool) | **The all-dash header question**: whether a suspended pool can print its pool row as all `-`. If it can, that row must survive `parseZpoolIostat` as a pool — the name half of the header rule exists for exactly this unknown, and this capture is the one that retires it. |

`up-suspended` recovers with `down`-style teardown: restore the dm-linear table, then
`zpool clear` (the pool comes back and can be destroyed cleanly); `zpool destroy -f`
after the table is restored is the fallback when the pool will not clear. Never touches
disks 1–6, `gtbackup`'s data or `gtiscsi`'s zvol — file vdevs live under the
`gtbackup` MOUNTPOINT but in a throwaway subdirectory, and the suspended pool's
backing file is its own.

## Pre-existing fixtures — synthetic

Everything here that is NOT in the zoo table above and not one of the two iscsi.3
captures (`zfs-list.json`, `zfs-get-*.json`, `zpool-list.json`, `zpool-get-all.json`,
`zpool-upgrade-*.txt`) is hand-written sample data built while the parsers were
written: they describe a fictional `testpool` with round sizes and no host ever had
those pools. They are shaped after real command output and remain fine as parser
fixtures, but they are **not captures** and must not be cited as evidence about how ZFS
behaves. When one of them is the only support for a behavioural claim, capture the real
thing instead. (The zoo table supersedes this file's earlier blanket claim that the
`zpool-status-*` files were all synthetic — the capturing commits say otherwise.)
