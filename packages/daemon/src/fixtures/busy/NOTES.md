# Busy-unmount root-cause diagnosis — ground truth (story 3.29)

Captured on the stunt node (`192.168.200.50`, PVE 9 / Debian 13) against the live
AHR pool `tank` mounted at `/mnt/anas-ahr/tank`. Two real holders were created —
one with an **open FD** on a file inside the mount, one with its **CWD** inside
it — exactly the shape of the pve5 incident (a chia harvester holding plot-dir
FDs kept `zpool destroy` from unmounting `/chiapools/pool15`).

## Tool choice: `fuser` (psmisc), not `lsof`

`fuser` ships in the Debian/PVE **base** install (`psmisc 23.7`); `lsof` had to be
`apt install`ed on this node (see `../mounts/NOTES.md` §5). "Prefer the tool that
is reliably present" → `fuser`. It is also the exact tool the operator was told
to run by hand during the incident.

`fuser -vm <path>` prints a rich USER/PID/ACCESS/COMMAND table, BUT it splits the
PID column onto **stdout** and the surrounding table decoration onto **stderr**;
our `CommandExecutor` captures the two streams separately, so the merged table
cannot be reliably reconstructed. The **terse** form is used instead:

- `fuser -m <path>` → bare PIDs on **stdout** (one token each, optionally suffixed
  with an access-type letter, e.g. `5961c` = cwd). Reliable, single-stream.
- The process **command** is then read from `/proc/<pid>/comm` (a plain fs read —
  no second exec). A PID that vanished between the `fuser` call and the `/proc`
  read is simply skipped.

The message shape is `held open by: <comm>(<pid>)[, …]`, capped at 5 with
`, +N more`. `fuser -m` does not report the user (that lives only in the
split verbose table), so the user is honestly omitted — matching the operator's
requested `chia_harvester(1234), smbd(567)` form.

## `fuser -m /mnt/anas-ahr/tank` (terse stdout) — two holders

`fuser-m-holders.txt`. Two live holders (`sleep` FD 483284, `sleep` CWD 483285).
`/proc/483284/comm` = `sleep`, `/proc/483285/comm` = `sleep`. Exit 0.

A second real capture from story 18.1 (`../mounts/busy-unmount.txt`) shows the
access-letter suffix form `5960  5961c` — the parser strips the trailing letters.

## No holders / missing path

- `fuser -m <path>` with nothing holding → empty stdout, exit 1.
- `fuser -m /no/such/path` → stderr `Specified filename /no/such/path does not
  exist.`, exit 1, empty stdout. Both → empty holder list (fail-open); the
  primary error is surfaced unchanged.

## The busy errors we enrich (verbatim, real)

- **ZFS pool/dataset** (the pve5 incident, operator-reported):
  `cannot unmount '/chiapools/pool15': pool or dataset is busy`
- **umount** (story 18.1 capture, `../mounts/busy-unmount.txt`):
  `umount: /mnt/anas-cifs: target is busy.` (exit 32)

Both match `/busy/i`. When the caller does not pass a known path, the path is
extracted from the error text: the `'…'` quoted path (ZFS) or the `umount: …:`
segment (umount).
