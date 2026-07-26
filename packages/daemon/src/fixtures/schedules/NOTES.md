# Schedules fixtures — provenance

Captured 2026-07-26 from the **stunt node** (`anas-pve`, 192.168.200.50):

- **PVE** `pve-manager/9.2.5` (running kernel `7.0.14-6-pve`)
- **ZFS** `zfs-2.4.3-pve1` (`zfsutils-linux`, `/usr/lib/zfs-linux/scrub`, cron.d from May 2023)

All files here are **verbatim copies** of what the node ships — real ground
truth, not transcribed from docs. Facts derived from them live in
`docs/SCHEDULES-GROUND-TRUTH.md`.

> **sanoid dropped (2026-07-26).** The schedule mechanism is now ANAS-owned and
> uniform across ZFS and AHR (docs/SCHEDULES-DESIGN.md supersedes the sanoid tool
> pick). The sanoid captures (`sanoid.defaults.conf`, `sanoid.conf.example`,
> `sanoid.conf.roundtrip`, `sanoid.timer`, `sanoid.service`,
> `sanoid-prune.service`) and the `sanoid.conf` parser were removed with the
> uniform-snapshot-core build — the *learning* (sanoid's retention model) carries
> forward in SCHEDULES-GROUND-TRUTH.md and the ANAS retention engine. The scrub
> fixtures below are retained: they are ZFS/PVE ground truth for the later
> scrub-surfacing stage, not sanoid.

| File | Source path on node | Verbatim? |
|------|---------------------|-----------|
| `zfs-scrub@.service` | `/lib/systemd/system/zfs-scrub@.service` | yes — per-pool scrub template |
| `zfs-scrub-monthly@.timer` | `/lib/systemd/system/zfs-scrub-monthly@.timer` | yes — disabled by default |
| `zfs-scrub-weekly@.timer` | `/lib/systemd/system/zfs-scrub-weekly@.timer` | yes — disabled by default |
| `zfsutils-linux.cron.d` | `/etc/cron.d/zfsutils-linux` | yes — the ACTIVE default: monthly scrub via cron |
| `zfs-linux-scrub.sh` | `/usr/lib/zfs-linux/scrub` | yes — gates on `org.debian:periodic-scrub` property |
