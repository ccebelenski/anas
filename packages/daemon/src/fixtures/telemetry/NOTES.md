# Telemetry fixtures — provenance

The "ground truth first" ruling asks every fixture to be labelled **real capture** vs
**synthetic**. This directory predates that labelling, so this file states what is known
about each file rather than pretending it was always recorded.

## Real captures

| File | Command | Captured | What it proves |
|------|---------|----------|----------------|
| `zpool-iostat-plv-all-vdev-classes-2.4.4.txt` | `zpool iostat -plv gtvdev 1 2` | 2026-09-24, stunt node `anas-pve` (PVE 9.2.20, `zfs-2.4.4`), story **vdevs.1** | How `zpool iostat` lays out a pool carrying **all six vdev classes** (`test/stunt-node/vdev-fixture.sh`): the `logs`, `cache`, `special` and `dedup` section headers print **unindented, in the pool column**, every value cell `-`, with their devices at the vdev indent — and a **spare gets no row at all**. Verbatim daemon stdout; only the trailing `\r` of the ssh transport was stripped. |

This is the capture behind `parseZpoolIostat`'s `knownPools` argument: read by
indentation alone those four headers become four phantom pools, which is what the
dashboard telemetry tree used to show for any pool with a log or cache device
(GitHub #66).

## Unattested

`zpool-iostat-plv.txt`, `arcstats.txt` and `proc-net-dev.txt` predate the labelling
rule. They describe the fictional `testpool` of the other synthetic fixtures and no
host ever had that pool, so they are shaped after real output but are **not captures**
and must not be cited as evidence about how a command behaves.
