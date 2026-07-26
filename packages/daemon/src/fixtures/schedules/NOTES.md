# Schedules fixtures — provenance

Captured 2026-07-26 from the **stunt node** (`anas-pve`, 192.168.200.50):

- **PVE** `pve-manager/9.2.5` (running kernel `7.0.14-6-pve`)
- **ZFS** `zfs-2.4.3-pve1` (`zfsutils-linux`, `/usr/lib/zfs-linux/scrub`, cron.d from May 2023)
- **sanoid** `2.2.0-2` (Debian trixie/main; `libconfig-inifiles-perl 3.000003`)

All files here EXCEPT `sanoid.conf.roundtrip` are **verbatim copies** of what the
node ships — real ground truth, not transcribed from docs. Facts derived from
them live in `docs/SCHEDULES-GROUND-TRUTH.md`.

| File | Source path on node | Verbatim? |
|------|---------------------|-----------|
| `sanoid.defaults.conf` | `/usr/share/sanoid/sanoid.defaults.conf` | yes — sanoid's key whitelist + default retention |
| `sanoid.conf.example` | `/usr/share/doc/sanoid/examples/sanoid.conf` | yes — shipped example (templates + per-dataset stanzas + comments) |
| `sanoid.timer` | `/usr/lib/systemd/system/sanoid.timer` | yes — every-15-min timer, enabled on install |
| `sanoid.service` | `/usr/lib/systemd/system/sanoid.service` | yes — `--take-snapshots`, ConditionFileNotEmpty gate |
| `sanoid-prune.service` | `/usr/lib/systemd/system/sanoid-prune.service` | yes — `--prune-snapshots`, pulled in by sanoid.service |
| `zfs-scrub@.service` | `/lib/systemd/system/zfs-scrub@.service` | yes — per-pool scrub template |
| `zfs-scrub-monthly@.timer` | `/lib/systemd/system/zfs-scrub-monthly@.timer` | yes — disabled by default |
| `zfs-scrub-weekly@.timer` | `/lib/systemd/system/zfs-scrub-weekly@.timer` | yes — disabled by default |
| `zfsutils-linux.cron.d` | `/etc/cron.d/zfsutils-linux` | yes — the ACTIVE default: monthly scrub via cron |
| `zfs-linux-scrub.sh` | `/usr/lib/zfs-linux/scrub` | yes — gates on `org.debian:periodic-scrub` property |
| `sanoid.conf.roundtrip` | — | **NO — authored** for the 17.2 parser round-trip test (see its header) |

The `.roundtrip` fixture is the sole authored file: it composes realistic
templates + per-dataset stanzas + comments + tab/space indentation + inline
overrides + one **deliberately-unknown key** (`anas_note`) to stress the
parser's unknown-directive preservation. Note SCHEDULES-GT-9: sanoid rejects
unknown keys fatally, so `anas_note` is a parser stress element only — never
written to a live config.
