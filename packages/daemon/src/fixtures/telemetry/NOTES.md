# Telemetry fixtures — provenance

The "ground truth first" ruling asks every fixture to be labelled **real capture** vs
**synthetic**. This directory predates that labelling, so this file states what is known
about each file rather than pretending it was always recorded.

## Real captures

| File | Command | Captured | What it proves |
|------|---------|----------|----------------|
| `zpool-iostat-plv-all-vdev-classes-2.4.4.txt` | `zpool iostat -plv gtvdev 1 2` | 2026-09-24, stunt node `anas-pve` (PVE 9.2.20, `zfs-2.4.4`), story **vdevs.1** | How `zpool iostat` lays out a pool carrying **all six vdev classes** (`test/stunt-node/vdev-fixture.sh`): the `logs`, `cache`, `special` and `dedup` section headers print **unindented, in the pool column**, every value cell `-`, with their devices at the vdev indent — and a **spare gets no row at all**. Verbatim daemon stdout; only the trailing `\r` of the ssh transport was stripped. |
| `zpool-iostat-plv-multi-cache-spare-2.4.4.txt` | `zpool iostat -plv gtvdev 1 2` | 2026-09-24, stunt node `anas-pve` (PVE 9.2.20, `zfs-2.4.4`), story **vdevs.1/.2** fix batch (`c10b976`) | The **multi-entry sections** (the by-id partitions-of-one-disk shape, `test/stunt-node/vdev-fixture.sh`): long by-id **partition** names at the vdev indent under the same all-dash section headers — `cache` with **two** leaves — and the **spares again get no row at all**. Verbatim daemon stdout; only the trailing `\r` of the ssh transport was stripped. |
| `zpool-iostat-plv-all-vdev-classes-jv-2.4.4.txt` | `zpool iostat -plv gtvdev 1 2` | 2026-09-25, stunt node `anas-pve` (PVE 9.2.20, `zfs-2.4.4-pve1`, kernel 7.0.14-17-pve), story **topology.1** (`test/stunt-node/topology-zoo.sh capture all-vdev-classes`) | The six-class shape rebuilt and re-captured beside its `-p` sibling above. Same layout facts (`dedup`/`special`/`logs`/`cache` headers unindented and all-dash, devices at the vdev indent, **the spare prints no row**), on a pool the status half of this run captured at the same moment — the pair is self-consistent where the older pair needed the pool name rewritten in memory. Verbatim daemon stdout; only the ssh transport's `\r` was stripped. |
| `zpool-iostat-plv-multi-cache-spare-jv-2.4.4.txt` | `zpool iostat -plv gtvdev 1 2` | 2026-09-25, same node/session, story **topology.1** (`capture multi-cache-spare`) | The multi-entry sections re-captured as a matched pair with their status half: `cache` with **two** by-id partition leaves, **two spares that print no row**. Verbatim daemon stdout; only the ssh transport's `\r` was stripped. |
| `zpool-iostat-plv-mirrored-log-partitions-jv-2.4.4.txt` | `zpool iostat -plv gtvdev 1 2` | 2026-09-25, same node/session, story **topology.1** (`capture mirrored-log-partitions`) | The only capture here with **depth-2 rows**: a `mirror-1` at the vdev indent under the `logs` header with its two by-id partition leaves indented under it. The in-tree **file** data root prints a normal vdev row (it is the STATUS side that gives it no leaf). Verbatim daemon stdout; only the ssh transport's `\r` was stripped. |
| `zpool-iostat-plv-file-vdev-2.4.4.txt` | `zpool iostat -plv gtvdev 1 2` | 2026-09-25, same node/session, story **topology.1** (`capture file-vdev`) | **File vdevs throughout**: the data root and the `logs`/`cache` section leaves are all absolute file paths at their indents, under the same all-dash headers. The file-backed **spare prints no row**, exactly as a disk spare does. Verbatim daemon stdout; only the ssh transport's `\r` was stripped. |
| `zpool-iostat-plv-byid-whole-disk-2.4.4.txt` | `zpool iostat -plv gtvdev 1 2` | 2026-09-25, same node/session, story **topology.1** (`capture byid-whole-disk`) | The plainest shape in the zoo and the control for the header rule: a single by-id whole-disk vdev row and **no section header anywhere**, so the parser is exercised on a capture that has nothing to drop. Verbatim daemon stdout; only the ssh transport's `\r` was stripped. |
| `zpool-iostat-plv-suspended-2.4.4.txt` | `zpool iostat -plv gtvdev 1 2` | 2026-09-25, same node/session, story **topology.1** (`capture suspended`, pool on a dm-error device) | **Settles the all-dash header question.** A SUSPENDED pool does **not** print its pool row as all `-`: the since-boot sample carries real counters (alloc/free and the I/O that failed), and the interval sample prints the ordinary zeroes-and-dashes any idle pool prints. So no suspended pool can be mistaken for a section header, and the name half of the all-dash rule is not load-bearing for this case. The command returns in ~1s against the suspended pool — it does not block. Verbatim daemon stdout; only the ssh transport's `\r` was stripped. |

This is the capture behind `parseZpoolIostat`'s `knownPools` argument: read by
indentation alone those four headers become four phantom pools, which is what the
dashboard telemetry tree used to show for any pool with a log or cache device
(GitHub #66).

## Unattested

`zpool-iostat-plv.txt`, `arcstats.txt` and `proc-net-dev.txt` predate the labelling
rule. They describe the fictional `testpool` of the other synthetic fixtures and no
host ever had that pool, so they are shaped after real output but are **not captures**
and must not be cited as evidence about how a command behaves.
