# `btrfs scrub start -B` — captured output (cr3 ahr-heal, second review item 1)

Captured by the coordinator on PVE 9, btrfs-progs v6.14, on a scratch btrfs
filesystem on a loop device, 2026-11-14. Bytes verbatim; the mount path in the
stderr capture was given as `<mnt>`.

| File | What it is |
|------|------------|
| `btrfs-scrub-start-B-clean.stdout.txt` | `btrfs scrub start -B <mnt>` on a clean filesystem: rc 0, stderr empty, this stdout. Identical under `TZ=UTC LC_ALL=C`. The pass's own verdict: `scrub done for <fsid>`, then the stats block `scrub status` prints. |
| `btrfs-scrub-start-B-already-running.stderr.txt` | A second `btrfs scrub start -B <mnt>` while the first runs: rc 1, stdout EMPTY, this stderr. |
