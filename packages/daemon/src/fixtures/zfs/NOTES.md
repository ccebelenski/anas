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
row below is a contract, not a description. Which command produced which file — and
which captures were taken with an argv the daemon never issues — is the subject of
the **Capture argv** section below.

Provenance comes from each file's own git history (`git log --follow`) and its
`_comment` where it has one — never from inside the JSON. March 2026 captures are from
the stunt node of that period (PVE 9, "ZFS 2.4" per the capturing commit); the
`*-2.4.4` files are verbatim daemon stdout from the current stunt node (PVE 9.2.20,
`zfs-2.4.4`), either from the vdevs.1/vdevs.2 ground-truth sessions of 2026-09-24 or
from the topology.1 capture run of 2026-09-25 (the six files whose rows name that
run). One cross-fixture fact the zoo exposed: some files quote `pool_guid` (a JSON
string) and others emit it UNQUOTED (libzfs's uint64) — the parser passes it through
verbatim, so `guid` is number-typed on exactly the `-p` captures. The topology.1 run
settled why; see **Capture argv**. For files added with a feature commit and without
a recorded capture, provenance is stated as **unrecorded** — read them as
capture-shaped until a capture replaces them, not as evidence about how ZFS behaves.

### Capture argv

The daemon issues `zpool status -jv` (all pools, no `-p` — `routes/disks.ts` and
`routes/pools.ts`). That is the ONLY argv a status fixture may be captured with;
`test/stunt-node/topology-zoo.sh capture` captures exactly it. The iostat half is
`zpool iostat -plv <pool> 1 2` throughout.

**The three unsuffixed `*-2.4.4` status captures below were taken with `-j -p`** —
the parseable-numbers form: numbers unquoted, sizes in raw bytes. They are real
captures and 0.3.5's tests pin them, so they stay checked in, but they are a wire
form the daemon never receives. Each now has a `-jv` re-capture checked in beside
it under the same name plus `-jv` (2026-09-25); both are kept, because their parser
output is NOT identical — the `-p` files parse `guid` to a number and their sizes
are raw byte counts, the `-jv` files parse `guid` to a string and their sizes are
display form.

That pair also **settles** the pool_guid difference the zoo exposed, which was
previously an inference: the older files quote `pool_guid` (a JSON string), the `-p`
2.4.4 captures emit it UNQUOTED (libzfs's uint64). Both forms now exist for the same
three shapes on the same ZFS build, captured a day apart on the same node, and they
differ in exactly that way — so it is the `-p` flag, not the ZFS version. The parser
passes the value through verbatim either way.

| File | Pool (state) | ZFS | Captured | Layout facts pinned |
|------|--------------|-----|----------|---------------------|
| `zpool-status-online.json` | `testpool` (ONLINE) | 2.4 | 2026-03-15 (`6cc715e`), then rewritten by hand (`45f153a` "richer mock data") | Two `mirror-N` data vdevs + a pool-level `spares` section; leaves by-id **partitions** (`-part1`) with `devid` and `phys_path`; a FINISHED scrub record. The second mirror is mock and **all five WD serials are invented** (`WD-12345678`…`WD-56789012`) — treat the mirror count, not the drive identity, as the pinned fact. |
| `zpool-status-online-fresh.json` | `testpool` (ONLINE) | 2.4 | 2026-03-16 (`b264078`, story 3.16) | Single mirror; **no `scan_stats`** at all — the "none requested" shape. |
| `zpool-status-degraded.json` | `testpool` (DEGRADED) | 2.4 | 2026-03-16 (`b264078`) | Mirror with an **OFFLINE** leaf (admin offline); pool `status`/`action`/`msgid` health block; no scan record. |
| `zpool-status-degraded-removed.json` | `testpool` (DEGRADED) | 2.4 | 2026-03-16 (`b264078`) | Mirror with a **REMOVED** leaf (disk yanked); FINISHED resilver retained. |
| `zpool-status-degraded-offline.json` | `testpool` (DEGRADED) | 2.4 | 2026-03-16 (`b264078`) | The offline-leaf sibling of the above with its own FINISHED-resilver record. |
| `zpool-status-suspended.json` | `testpool` (SUSPENDED) | 2.4 | 2026-03-16 (`b264078`; all disks yanked) | Pool **SUSPENDED** with `ZFS-8000-HC` health block, `error_count: 4`, per-leaf error counters non-zero, the old resilver record still carried. Pre-dates the zoo; the suspended capture the story owes is re-taken under 2.4.4 (below). |
| `zpool-status-suspended-verbose.json` | `testpool` (SUSPENDED) | 2.4 | 2026-03-16 (`b264078`) | The `-v` form of the same shape: **`errlist`** present (error detail beyond the count). |
| `zpool-status-raidz.json` | `testpool-rz` (ONLINE) | 2.4 | 2026-03-16 (`b264078`) | One `raidz1-0` with three disk leaves; no scan. |
| `zpool-status-raidz-degraded.json` | `testpool-rz` (DEGRADED) | 2.4 | 2026-03-16 (`b264078`) | raidz with a REMOVED leaf; FINISHED scrub retained. |
| `zpool-status-resilvering.json` | `testpool` (ONLINE) | 2.4 | 2026-03-16 (`b264078`) | FINISHED **RESILVER** (`processed` = the repaired bytes ZFS prints). |
| `zpool-status-scrubbing.json` | `testpool-rz` (ONLINE) | 2.4 | 2026-03-16 (`b264078`) | **SCANNING** scrub: `end_time` unset, `finishedAt` null. |
| `zpool-status-scrub-verdicts.json` | `repairpool` + `cancelpool` (ONLINE) | — | 2026-08-17 (`6042272`, story 17.3) — **canonical forms, NOT captures** (its own `_comment` says so; producing repaired/canceled verdicts live would damage a pool) | A FINISHED scrub that repaired `1.50M` with 2 errors; a **CANCELED** scrub (its zero errors must never read as a clean bill); a leaf NAMED by-id whole-disk (`ANAS_C3`, no `-partN`) — a synthetic file pins the name-vs-path read only, not the whole-disk layout fact, which is `up-byid-whole`'s capture to settle (below). |
| `zpool-status-with-spare.json` | `testpool` (ONLINE) | 2.4 | 2026-03-16 (`04a8aca`) — provenance **unrecorded** | A healthy mirror + an **AVAIL** spare in the pool-level `spares` section (QEMU stunt-node naming). |
| `zpool-status-spare-active.json` | `testpool` (DEGRADED) | 2.4 | 2026-03-16 (`04a8aca`) — provenance **unrecorded** | ZFS's **activated-spare** shape: the data mirror carries a `spare-1` vdev (failed leaf REMOVED, spare ONLINE) while `spares` still lists the spare **INUSE**; the same disk appears in both places. |
| `zpool-status-all-vdev-classes-2.4.4.json` | `gt66` (ONLINE) | 2.4.4 | 2026-09-23/24, stunt node (vdevs.1 GT) | One pool, **all six classes**, one partition each, **kernel names** (`sdb1`–`sdb6`, no by-id anywhere — the CLI-built shape); all five pool-level sections (`logs`, `l2cache`, `spares`, `special`, `dedup`) beside the tree. **`-p` form** — numbers unquoted, sizes in bytes; RE-CAPTURE under `-jv` owed, see Missing shapes. |
| `zpool-status-mirrored-log-partitions-2.4.4.json` | `gtbackup` (ONLINE) | 2.4.4 | 2026-09-23/24, stunt node (vdevs.1 GT) | **File vdev as the data root** (`vdev_type: "file"`, `/var/tmp/gtbackup.img`); a **mirrored log inside the `logs` section** (`mirror-4` with two partition leaves); a bare disk cache. KNOWN QUIRK it pins: the in-tree file vdev parses with **zero leaves** — only pool-level bare entries become leaves — which is exactly the shape the missing file-vdev capture below will re-examine. **`-p` form** — numbers unquoted, sizes in bytes; RE-CAPTURE under `-jv` owed, see Missing shapes. |
| `zpool-status-multi-cache-spare-2.4.4.json` | `gtvdev` (ONLINE) | 2.4.4 | 2026-09-24, stunt node (vdevs.1/.2 fix batch, `c10b976`) | **By-id partitions of ONE disk** for every class; `l2cache` with **two** bare leaves and `spares` with **two** (the multi-entry sections that fold into one container vdev each); single-leaf `logs` takes the same container shape. **`-p` form** — numbers unquoted, sizes in bytes; RE-CAPTURE under `-jv` owed, see Missing shapes. |
| `zpool-status-all-vdev-classes-jv-2.4.4.json` | `gtvdev` (ONLINE) | 2.4.4 | 2026-09-25, stunt node (topology.1 capture run) | The six-class shape under the argv the daemon ACTUALLY issues (`zpool status -jv`, no `-p`) — the `-jv` re-capture the `-p` file above owed. Same layout as its sibling (one partition per class, **kernel names** `sdb1`–`sdb6`, all five pool-level sections), so the only difference is the wire form: `pool_guid` and every counter are JSON **strings** and sizes are DISPLAY form (`384M`, `1.16G`). Together the two files are the A/B that proves the quoted-vs-unquoted guid is the `-p` flag and not the ZFS version — same build, same day's fixture, both forms. |
| `zpool-status-multi-cache-spare-jv-2.4.4.json` | `gtvdev` (ONLINE) | 2.4.4 | 2026-09-25, stunt node (topology.1 capture run) | The multi-entry sections under `-jv`: `l2cache` with **two** bare by-id partition leaves and `spares` with **two**, each folding into one container vdev; single-leaf `logs` takes the same container shape. |
| `zpool-status-mirrored-log-partitions-jv-2.4.4.json` | `gtvdev` (ONLINE) | 2.4.4 | 2026-09-25, stunt node (topology.1 capture run) | The file-root/mirrored-log/disk-cache structure under `-jv`, rebuilt on disk 9 so the log mirror's leaves are **by-id partitions** where the `-p` capture's are kernel-named (`sdb1`/`sdb2`) — the leaf naming differs on purpose. Confirms the in-tree **file vdev still parses with zero leaves** on a second, independently built pool: the quirk is the shape, not that one pool. |
| `zpool-status-file-vdev-2.4.4.json` | `gtvdev` (ONLINE) | 2.4.4 | 2026-09-25, stunt node (topology.1 capture run) | A **dedicated file-vdev pool**: `vdev_type: "file"` on the data root AND on a file-backed `logs`, `l2cache` and `spares` entry. Settles both open questions — `zpool create` **does** accept a file as a log/cache/spare member (that risk is retired), and the asymmetry is real: the in-tree file vdev carries **zero leaves** while each pool-level file entry keeps its leaf, exactly as a bare disk entry does. |
| `zpool-status-byid-whole-disk-2.4.4.json` | `gtvdev` (ONLINE) | 2.4.4 | 2026-09-25, stunt node (topology.1 capture run) | The REAL by-id **whole-disk** layout (`zpool create` on `/dev/disk/by-id/<id>`), which until now rested on the synthetic `zpool-status-scrub-verdicts.json`. The evidence it lands: ZFS names the leaf by the **whole disk** (`scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9`, no `-partN`) while `path` and `devid` both point at the partition ZFS made underneath (`…-part1`). Name and path disagree by design here — the name is the read that must win. |
| `zpool-status-suspended-2.4.4.json` | `gtvdev` (SUSPENDED) | 2.4.4 | 2026-09-25, stunt node (topology.1 capture run; pool on a dm-linear device whose table was swapped to dm-error) | The suspended shape re-taken under the current build and the daemon's `-jv` argv (the March `zpool-status-suspended*.json` pre-date the zoo and its argv). Carries the `ZFS-8000-HC` health block, `error_count: "5"`, a root vdev `CANT_OPEN` with `aux: "NO_REPLICAS"` over a `FAULTED` leaf with `aux: "ERR_EXCEEDED"`, and no scan record. Two facts about the command itself: it **returns immediately** on a suspended pool rather than blocking, and it prints `errors: List of errors unavailable: pool I/O is currently suspended` on **stderr** — stdout stays valid JSON. Under `-jv` the `errlist` is not a list at all but the errno string `"Resource temporarily unavailable"`. |

The iostat half of the zoo lives beside its parser fixtures in `../telemetry/` (each
row there in `../telemetry/NOTES.md`); the pairs:

| File (under `../telemetry/`) | Pairs with | Pinned |
|------|------------|--------|
| `zpool-iostat-plv.txt` | synthetic `testpool` — **not a capture** (pre-labelling) | The base two-sample layout (`1 2` = since-boot + interval), tree depth by indentation. |
| `zpool-iostat-plv-all-vdev-classes-2.4.4.txt` | `zpool-status-all-vdev-classes-2.4.4.json` (the pool name is rewritten `gt66` → `gtvdev` IN MEMORY by the consumer test — the fixture file itself is never edited) | The vdev-class section headers print **UNINDENTED in the pool column, every cell `-`**; devices at the vdev indent; **a spare prints no row at all**. This is the capture behind the all-dash header rule. |
| `zpool-iostat-plv-multi-cache-spare-2.4.4.txt` | `zpool-status-multi-cache-spare-2.4.4.json` | By-id **partition** leaves at the vdev indent under the section headers — long names, two leaves per section. |
| `zpool-iostat-plv-all-vdev-classes-jv-2.4.4.txt` | `zpool-status-all-vdev-classes-jv-2.4.4.json` | The same header layout on a pool whose status half was captured in the same breath — no in-memory pool-name rewrite needed. |
| `zpool-iostat-plv-multi-cache-spare-jv-2.4.4.txt` | `zpool-status-multi-cache-spare-jv-2.4.4.json` | Two cache leaves; two spares that print no row. |
| `zpool-iostat-plv-mirrored-log-partitions-jv-2.4.4.txt` | `zpool-status-mirrored-log-partitions-jv-2.4.4.json` | The zoo's only **depth-2** rows: a `mirror-1` at the vdev indent with its two partition leaves indented beneath it. |
| `zpool-iostat-plv-file-vdev-2.4.4.txt` | `zpool-status-file-vdev-2.4.4.json` | File paths as row names at every indent; the file-backed spare prints no row. |
| `zpool-iostat-plv-byid-whole-disk-2.4.4.txt` | `zpool-status-byid-whole-disk-2.4.4.json` | The control: one vdev row, **no section header at all**. |
| `zpool-iostat-plv-suspended-2.4.4.txt` | `zpool-status-suspended-2.4.4.json` | A SUSPENDED pool prints **real counters**, not an all-dash row — the question the header rule was left open for. |

Also captured by the 3.16 session and feeding the same parsers: `zpool-list-raidz.json`
(the `testpool-rz` capture of `zpool list -j`).

### Missing shapes

**None.** Every shape this section listed as owed was captured on 2026-09-25 by
`test/stunt-node/topology-zoo.sh capture <shape>`, run one shape at a time on the
stunt node (`anas-pve`, 192.168.200.50, PVE 9.2.20, `zfs-2.4.4-pve1`, kernel
7.0.14-17-pve) against `test/stunt-node/vdev-fixture.sh`'s verbs: the three `-jv`
re-captures (`up`, `up-multi`, `up-mirrorlog`), the dedicated file-vdev pool
(`up-file`), the by-id whole-disk pool (`up-byid-whole`) and the suspended pool
(`up-suspended`). Their rows are in the zoo table above and their iostat halves in
`../telemetry/NOTES.md`. That run was also the first time either script had ever
been executed, so it is their proof as much as the captures'.

What the run retired, beyond the fixtures themselves:

- **`zpool create` does accept a file as a `log`, `cache` or `spare` member.** That
  was listed below as unverified; `up-file` built the pool on the first attempt.
- **The in-tree file vdev really does parse with zero leaves** while a pool-level
  file entry keeps its leaf. Two independently built pools show it, so it is the
  shape and not an accident of `gtbackup`.
- **The all-dash header question is answered: no.** A suspended pool prints real
  counters in its pool row, so it can never be mistaken for a section header. The
  name half of the all-dash rule is not carrying this case.
- **`zpool status -jv` does not block on a suspended pool** — it returns in
  milliseconds. `zpool iostat -plv … 1 2` returns in about a second. The command
  that DOES block is the forcing `zpool scrub`, and it blocks uninterruptibly (see
  below).

One shape the scripts can build has no capture here and none is owed:
`byid-partition-classes` (`up-byid`, six by-id partition leaves of one disk). Its
distinguishing fact — by-id `-partN` leaves in the pool-level sections — is already
pinned by `zpool-status-multi-cache-spare-jv-2.4.4.json`.

`up-suspended` recovers with `down`-style teardown: restore the dm-linear table, then
`zpool clear` (the pool comes back and can be destroyed cleanly); `zpool destroy -f`
after the table is restored is the FAILURE fallback when the pool will not clear.
**Proven on 2026-09-25**, including from a half-built shape whose forcing scrub was
still stuck: reloading the linear table released the blocked scrub and the pool
cleared and destroyed in about a second. Never touches disks 1–6, `gtbackup`'s data
or `gtiscsi`'s zvol — file vdevs live under the `gtbackup` MOUNTPOINT but in a
throwaway subdirectory, and the suspended pool's backing file is its own.

**The hang guard has one hole, and the first run fell in it.** `zpool scrub` — the
command `up-suspended` uses to force the I/O that suspends the pool — blocks in
uninterruptible D state (`cv_wait_common`) once the pool suspends under it. SIGTERM
never lands on a D-state task, so the `timeout 60` wrapper hangs alongside it rather
than bounding it, and the verb never returns. `up-suspended` therefore launches the
scrub **detached and never waits on it**; the pool-state poll is the real completion
test, and every zpool call the verb does wait on still runs under `timeout 60`. The
stuck scrub is released by the table restore in `down`.

Stated risks of the file-backed shapes: they stack ZFS on ZFS (short-lived display
fixtures, torn down at once) — accepted, and the 2026-09-25 run showed no trouble
from it; loop-device truncation WOULD fail I/O on its own, and dm-error is chosen
because it is deterministic. `capture` also stops `anasd` around the suspended shape
— the daemon's dashboard pull issues `zpool status -jv` with no pool argument and
would block on the suspended pool — and starts **both** `anasd` and `anas` again
afterwards, because the gateway unit is `PartOf=anasd.service` and `PartOf`
propagates stop and restart but never start.

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
