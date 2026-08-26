# Backup phase 2 — Restore / mount / `.img` / snapshot-continuity Ground Truth

> **Story `backup2.1`.** Captured 2026-08-25 on the disposable stunt node
> (`anas-pve`, 192.168.200.50) against the disposable PBS that story 16.1 stood up
> **on that same node**. No other host was contacted; no real PBS was touched.
>
> **Versions.** `proxmox-backup-client` and `proxmox-backup-server` **4.2.5-1**
> (the story text said 4.2.3 — the node has been upgraded since 16.1; `version
> --output-format json` reports `{"client":{"release":"5","version":"4.2"},"server":{…}}`).
> PVE `pve-manager/9.2.11`, kernel `7.0.14-12-pve`, ZFS `2.4.3-pve1`,
> `btrfs-progs v6.14`, `fuse3 3.17.2-3`.
>
> **Harness.** Datastore `anastest-store` (dir-backed, `/testpool/pbs-store` — a plain
> directory now; the old `testpool` zpool is gone), a **new** namespace `gtrestore`,
> API token `root@pam!anas-test`. A **new** file-backed pool `gtbackup`
> (`/var/tmp/gtbackup.img`, 8 GiB) held every source tree; a temporary loop-backed
> btrfs held the AHR-shaped test. Every fact below is real command output; the
> durable copies live in `packages/daemon/src/fixtures/backup/` (see its `NOTES.md`
> for the real-vs-synthetic index).
>
> **No parser and no product code was written.** Reality first.

---

## 1. `snapshot list` / `catalog dump` — the point-in-time picker's read

**GT-1 — `snapshot list --output-format json` has NO `snapshot` field.** The
composite id the human table shows (`host/gtrestore/2026-08-25T19:16:45Z`) is not in
the JSON; the client returns the three parts separately and the caller composes
`<backup-type>/<backup-id>/<RFC3339 of backup-time>`:

```json
[{"backup-id":"gtrestore","backup-time":1787685405,"backup-type":"host",
  "files":[{"crypt-mode":"none","filename":"data.pxar.didx","size":2607},
           {"crypt-mode":"none","filename":"catalog.pcat1.didx","size":327},
           {"crypt-mode":"none","filename":"index.json.blob","size":375}],
  "owner":"root@pam!anas-test","protected":false,"size":3309}]
```

`backup-time` is **unix seconds** (same as prune, 16.1 §8). `owner` is the auth-id
(SURPRISE A still holds). `protected` is a boolean.

**GT-2 — the group form and the namespace form return the SAME element shape.**
`snapshot list --ns <ns>` (whole namespace) and `snapshot list <type>/<id> --ns <ns>`
(one group) both return a flat array of the GT-1 object; the namespace form simply
contains every group's snapshots. **The array is NOT sorted by `backup-time`** — the
`gtcdm` capture came back in the order `…412, …408, …410, …405, …414, …416`. The
picker must sort.

**GT-3 — `files` is an array of OBJECTS in `snapshot list`, but an array of STRINGS
in `list` (group listing).** Two different shapes for the same word:

```json
// snapshot list  →  [{"crypt-mode":"none","filename":"data.pxar.didx","size":2607}, …]
// list           →  {"backup-count":1,"backup-id":"gtrestore","backup-type":"host",
//                    "files":["catalog.pcat1.didx","index.json.blob","data.pxar.didx"],
//                    "last-backup":1787685405,"owner":"root@pam!anas-test"}
```

**GT-4 — `files[].size` is the LOGICAL archive size, and it is the space check.**
`data.pxar.didx` size `2607` matches the run's `2.546 KiB`; `cdm.pxar.didx` size
`4338224` matches `4.137 MiB`; an `.img` archive reports its full device size
(`lun.img.fidx` → `536870912`). `index.json.blob` is listed by `snapshot list` /
`snapshot files` but is **absent from the manifest's own `files` array** — it *is* the
manifest. A restore-space estimate needs no download: read `size` off
`snapshot files`.

**GT-5 — a nonexistent group and an empty namespace both return `[]` with exit 0**,
not an error. `snapshot list host/nosuchgroup --ns gtrestore` → `[]`, exit 0.

**GT-6 — `catalog dump` has no JSON at all and writes to STDERR.**
`--output-format json` is rejected outright:

```
Error: parameter verification failed - 'output-format': schema does not allow additional properties.
### exit=255
```

Stream proof: `catalog dump … 2>/dev/null | wc -c` → **0**;
`catalog dump … 2>&1 1>/dev/null | wc -c` → **971**. (Same as SURPRISE C.)

Its line format is `<type> "<quoted path>"[ <size> <mtime>]`, paths prefixed with
`./<archive-file-name>/`, trailing padding spaces:

```
d "./data.pxar.didx"
f "./data.pxar.didx/acl-xattr.txt" 13 2026-08-25T19:16:23Z
f "./data.pxar.didx/bracket[1].txt" 11 2026-08-25T19:16:23Z
d "./data.pxar.didx/docs"
h "./data.pxar.didx/hard-b.txt"
l "./data.pxar.didx/link-to-alpha"
f "./data.pxar.didx/mix [a] * b.txt" 10 2026-08-25T19:16:23Z
```

Types seen: `d` dir, `f` file, `h` hardlink, `l` symlink. **Names are quoted but not
escaped** — a name containing `"` would break a naive parser.

**GT-7 — `catalog dump` works on metadata-mode snapshots too** (it reads the
`.mpxar`), contradicting the 16.1 shorthand "metadata → NO catalog". What metadata
mode lacks is the stored `catalog.pcat1.didx` FILE; the dump command still works:

```
d "./cdm.mpxar.didx/a"
f "./cdm.mpxar.didx/a/f1.bin" 2056 2026-08-25T19:33:32Z
```

On an `.img` snapshot it fails: `Error: manifest does not contain file
'catalog.pcat1.didx'`, exit 255.

**GT-8 — `catalog shell` is a complete NON-FUSE archive browser, and it is
scriptable over a pipe.** No tty needed:

```
$ printf 'find *.txt\nselect alpha.txt\nrestore-selected /gtbackup/csh\nexit\n' \
    | proxmox-backup-client catalog shell host/gtrestore/2026-08-25T19:16:45Z data.pxar --ns gtrestore
Starting interactive shell
/acl-xattr.txt
/alpha.txt
…
/sub/deep/deep.txt
/with space.txt
added path: "/alpha.txt"
### exit=0
$ find /gtbackup/csh
/gtbackup/csh
/gtbackup/csh/alpha.txt
```

Commands: `cd`, `ls`, `pwd`, `stat`, `find <pattern>`, `select`/`deselect`/
`clear-selected`/`list-selected`, `restore <target> [--pattern …]`,
`restore-selected <target>`, `exit`. `stat` renders awkward names correctly
(`/star*name.txt`, `/mix [a] * b.txt`). It works on **default AND metadata** archives
(`cdm.mpxar` and `cdm.pxar` are both accepted). On an `.img`:
`Error: Can only mount pxar archives.` **exit 255**.

### Addendum — what `catalog shell` gives a PICKER (story backup2.5, 2026-08-26)

> GT-8 established that the browser exists and is scriptable. Building the picker
> needed the shape of its answers, which `backup2.1` had not captured. These
> facts come from `fixtures/backup/catalog-shell-browse.txt` — read-only probes
> against the same disposable PBS (client/server 4.2.5-1), same namespace.

**GT-8a — `ls` prints BARE NAMES and NOTHING ELSE.** One plain name per line on
**stdout**, no type marker, no size, no trailing `/` on a directory (`cat -A`
proof in the fixture). The `Starting interactive shell` banner is the only thing
on **stderr** for a clean run. A picker therefore cannot get types from `ls`.

**GT-8b — `ls` of a FILE echoes the file's own name** (exit 0, no error). Without
a second question, a level would show a directory that contains itself.

**GT-8c — `stat` is the only type source, and it is a fixed four-line block:**

```
  File: /link-to-alpha -> "alpha.txt"
  Size: 0             Type: symlink
Access: (777/lrwxrwxrwx  )  Uid: 0     Gid: 0
Modify: 2026-08-25 19:16:23
```

Types seen: `directory`, `file`, `symlink`. **A HARDLINK is rendered as a
`symlink`** pointing at the group's PRIMARY name — told apart only by its mode,
`Access: (0/L---------  )`, with an epoch `Modify`. That `L` is pxar's own
format-mode letter for a hardlink and is the discriminator. `Modify` carries **no
timezone**, so any ISO conversion would be an invented offset.

**GT-8d — argument quoting. Backslash-escaping UNQUOTED is the only complete
form.** An unquoted space splits the argument
(`Error: got additional arguments: ["space.txt"]`). Double quotes, single quotes
and `\\ ` all resolve correctly — but **a backslash inside double quotes is
LITERAL** (`"/with\\ space.txt"` looked for `with\\ space.txt`), so a quoted
argument cannot escape the quote character itself. `*` and `[` are never globbed.
Verified against the real archive: `ls /mix\\ \\[a\\]\\ \\*\\ b.txt` →
`mix [a] * b.txt`.

**GT-8e — a per-command error is on STDERR and the shell stays at exit 0**, and
keeps going: `ls /nosuchdir` prints `Error: no such file or directory: "nosuchdir"`
and the next `ls` still answers. A non-zero exit means the shell never STARTED.
One command per line — a `;` is parsed as more arguments, never a separator.

**GT-8f — the start-up failures all exit 255** (GT-6/GT-56 confirmed without a
pipe swallowing the code): missing archive (`archive not found in manifest`),
missing snapshot / group / namespace (one identical string), missing type suffix
(`failed to parse archive type for 'data'`), an `.img`
(`Can only mount pxar archives.`), a closed port (`client error (Connect)` plus
the 4.2.5 `Caused by:` cause), and a no-permission token —
`Error: no permissions on /datastore/<store>/<ns>`, **different wording** from
`snapshot list`'s `permission check failed - missing Datastore.Audit|Datastore.Backup`.
A **nonexistent namespace** is `Error: ENOENT`, exit 255 — unlike an EMPTY one,
which is `[]` at exit 0 (GT-5).

**GT-8g — `.ppxar` browses too.** `catalog shell` accepts `.pxar`, `.mpxar` AND
the metadata-mode payload `.ppxar`, all returning the same tree.

**GT-8h — a session is cheap: one process, one catalog fetch.** `ls` + `exit`
measured **0.028 s** on a 2.5 KiB archive and **0.063 s** on a 250 MiB one; `ls`
plus **500 `stat`s in a single session** took **0.083 s** and produced 2 500
stdout lines. Batching a level's stats into one invocation costs nothing.

**GT-8i — the composed id round-trips.** `host/gtbig/2026-08-25T19:22:02Z`, built
by ANAS from the three parts GT-1 returns, was accepted verbatim by
`snapshot files` — confirming PBS renders `backup-time` as UTC RFC3339 with
second resolution and a `Z` zone.

---

## 2. Restore into an existing tree

Source tree: files, nested dirs, an empty dir, a symlink, a hardlink pair, an
ACL+xattr file, and names containing `*`, `[`, and a space. Before every probe the
tree was reset and drifted: one file modified, one deleted, a nested file modified,
the symlink retargeted, the hardlink broken into a separate file, ownership/mode
changed, a whole subdirectory deleted, and a foreign directory added.
Full matrix: `packages/daemon/src/fixtures/backup/restore-flag-matrix.txt`.

**GT-9 — with NO flags, restore into an existing tree dies at the FIRST existing
file**, after extracting nothing:

```
Error: error extracting archive - encountered unexpected error during extraction: error at entry "acl-xattr.txt": failed to extract file: failed to create file "acl-xattr.txt": EEXIST: File exists
### exit=255
```

**GT-10 — the TARGET directory itself may exist without `--allow-existing-dirs`;
SUBdirectories inside the archive may not.** `--allow-existing-dirs` alone changed
nothing (still died on the first file); `--overwrite-files` alone got past the files
and died on the first archive subdirectory:

```
Error: error extracting archive - … error at entry "docs": failed to enter directory: EEXIST: File exists
```

**GT-11 — the flags are four independent gates, and `--overwrite` covers three of
them but NOT directories.** Ladder as observed:

| flags | result |
|---|---|
| *(none)* | 255 — dies on the first existing **file** |
| `--allow-existing-dirs` | 255 — dies on the first existing **file** |
| `--overwrite-files` | 255 — dies on the first existing **directory** (`failed to enter directory`) |
| `--overwrite` | 255 — dies on the first existing **directory** (so `--overwrite` ⊅ `--allow-existing-dirs`) |
| `--allow-existing-dirs --overwrite-files` | 255 — dies on the **hardlink** (`failed to extract hardlink: EEXIST`) |
| `--allow-existing-dirs --overwrite-files --overwrite-symlinks` | 255 — still dies on the hardlink |
| `--allow-existing-dirs --overwrite-files --overwrite-symlinks --overwrite-hardlinks` | **exit 0** |
| **`--allow-existing-dirs --overwrite`** | **exit 0** — the minimal in-place pair |

`--overwrite` is exactly `--overwrite-files` + `--overwrite-symlinks` +
`--overwrite-hardlinks` (its help text, "overwrite already existing files", is
identical to `--overwrite-files`'s and is wrong).

**GT-12 — an in-place restore is a MERGE, never a sync.** In every successful probe
the foreign `extra-not-in-backup/x.txt` survived untouched. Restore **never deletes**
anything that is not in the archive.

**GT-13 — a successful in-place restore fully repairs identity**: the deleted file
came back, the modified files went back to v1, the retargeted symlink returned to
`-> alpha.txt`, and the broken hardlink pair was **re-linked** (`hard-a.txt` and
`hard-b.txt` back to one inode, `Links: 2`). ACLs, xattrs, mode and ownership were
re-applied.

**GT-14 — the `--ignore-*` flags, measured on a FRESH target**
(`restore-ignore-flags.txt`):

| flag | effect |
|---|---|
| *(none)* | owner `0:0` / `1000:1000` as archived, mode as archived, named ACL entry present, `user.anas.gt` xattr present |
| `--ignore-acls` | named ACL entry **gone**; mode still set (group bits come from the mode byte, so `rw-rw-r--` instead of the ACL-masked view) |
| `--ignore-xattrs` | `user.anas.gt` **gone**; the POSIX **ACL is still applied** (ACLs are not carried as generic xattrs in pxar) |
| `--ignore-ownership` | every entry owned by the restoring process (root:root); modes/ACLs/xattrs intact |
| `--ignore-permissions` | newly created files land **0600**, not the archived mode and not umask; ACL-carrying files still get their mode from the ACL |

On an **existing** target, `--ignore-ownership` additionally means the pre-existing
owner is left alone (the drifted `1001:1001` stayed).

**GT-15 — restoring into a NEW directory (the UI default) needs no flags, and the
directory need not exist.** `restore … /gtbackup/restore-missing` with the path
absent → exit 0, path created; deep missing parents (`/gtbackup/nope/a/b/c`) are
created too (mkdir -p semantics).

**GT-16 — the archive-name argument must carry its type suffix.**
`data` → `Error: failed to parse archive type for 'data'` (255). Both `data.pxar` and
the stored name `data.pxar.didx` are accepted.

---

## 3. `--pattern` — syntax, anchoring, escaping

Full matrix: `restore-pattern-matrix.txt` (27 + 11 + 7 probes).

**GT-17 — patterns are matched against the path INSIDE the archive; a host path
matches nothing.** `--pattern /gtbackup/data/alpha.txt` → 0 entries, **exit 0**.

**GT-18 — a leading `/` ANCHORS to the archive root; without it the pattern matches
any path SUFFIX, at any depth.** Proven with three files all named `alpha.txt`:

```
--pattern alpha.txt        → alpha.txt  sub/alpha.txt  sub/nest/alpha.txt   (3 files!)
--pattern /alpha.txt       → alpha.txt                                       (1 file)
--pattern /sub/alpha.txt   → sub/alpha.txt
--pattern /sub/nest/alpha.txt → sub/nest/alpha.txt
```

It is a **suffix** match, not a basename match: `deep/deep.txt` (no leading slash)
matched `sub/deep/deep.txt`. A trailing `/` is a no-op (`docs/` ≡ `docs`). This is the
same pattern language as `--exclude` (16.1 §4).

**GT-19 — `*` does not cross `/`; `**` does.** `sub/*.txt` matched only
`sub/mid.txt`; `sub/*/*.txt` matched `sub/deep/deep.txt`; `**` alone matched every
entry. `?` matches one character; `[ab]*` is a real character class (matched
`acl-xattr.txt alpha.txt beta.txt bracket[1].txt`).
**A bare `*` is rejected by the parameter schema** (`'pattern': value does not match
the regex pattern`, exit 255) — as is `--pattern /`. `**` is accepted.

**GT-20 — naming a DIRECTORY restores it recursively** (`--pattern docs` → `docs/`,
`docs/notes.txt`, `docs/readme.md`) — including a directory matched by a glob
(`/sub/*` matched the dir `sub/nest` and pulled its contents).

**GT-21 — an EMPTY directory cannot be restored by `--pattern`.**
`--pattern empty` → 0 entries, exit 0. Directories are materialized only as parents
of matching entries.

**GT-22 — escaping. `[` is the trap, not `*`.**

| filename | pattern | restored |
|---|---|---|
| `star*name.txt` | `star*name.txt` | that one file (only because nothing else matches `star…name.txt`) |
| `star*name.txt` | `star\*name.txt` | that one file ✔ |
| `star*name.txt` | `star[*]name.txt` | that one file ✔ |
| `bracket[1].txt` | `bracket[1].txt` | **NOTHING** — `[1]` is a character class, so the pattern means `bracket1.txt` |
| `bracket[1].txt` | `bracket\[1\].txt` | that one file ✔ |
| `with space.txt` | `with space.txt` | that one file ✔ (no escaping needed; it is one argv element) |
| `mix [a] * b.txt` | `mix \[a\] \* b.txt` | that one file ✔ |

**Rule for the picker: emit `/` + the archive-relative path with `\`, `*`, `?`, `[`
and `]` backslash-escaped.** Spaces need nothing (argv, never a shell).

**GT-23 — `--pattern` may be repeated** ("Can be specified more than once" is true):
`--pattern alpha.txt --pattern docs/readme.md` restored both plus the `docs` parent.

**GT-24 — a pattern that matches nothing is a SILENT SUCCESS: exit 0, zero files.**
The client will not tell you the user's selection was wrong; the daemon must verify.

**GT-25 — picking the SECOND name of a hardlink pair on its own FAILS the whole
restore:**

```
--pattern hard-b.txt
Error: error extracting archive - … error at entry "hard-b.txt": failed to extract hardlink: ENOENT: No such file or directory
### exit=255
```

The picker must pull in a hardlink's partner (or restore hardlinks as regular
copies) — there is no flag for this.

**GT-26 — an in-place single-file restore in a SUBDIRECTORY still needs
`--allow-existing-dirs`.** A root-level file does not:

```
--pattern /alpha.txt --overwrite                             → exit 0
--pattern /docs/readme.md --overwrite                        → 255: "error at entry \"readme.md\": failed to extract file: failed to get parent directory file descriptor: EEXIST: File exists"
--pattern /docs/readme.md --overwrite --allow-existing-dirs  → exit 0
```

---

## 4. FUSE `mount` — deps, lifecycle, and the hang trap

**GT-27 — the deps are already there on a stock PVE 9 node.** `/dev/fuse` present
(`crw-rw-rw- root root 10,229`), `fuse3 3.17.2-3` installed (PVE needs it for
`/etc/pve`), `fusermount3` in `/usr/bin`. Nothing to install.

**GT-28 — `mount` DAEMONIZES by default** (`--verbose` = "Verbose output and stay in
foreground"). The shell returned in ~57 ms; the client reparents to PID 1:

```
    PID    PPID STAT ELAPSED COMMAND
 355221       1 Ssl        0 proxmox-backup-client mount host/gtrestore/…Z data.pxar /run/anas-gt-mnt --ns gtrestore
```

It prints `FUSE library version: 3.17.2` on **stderr** and exits 0.

**GT-29 — the mount is read-only and identifiable.**
`findmnt`: `TARGET=/run/anas-gt-mnt SOURCE=/dev/fuse FSTYPE=fuse
OPTIONS=ro,nosuid,nodev,relatime,user_id=0,group_id=0,default_permissions`.
A write attempt → `Read-only file system`. `findmnt --json` gives the same fields.
**The mountpoint's `st_dev` IS the FUSE connection id** under
`/sys/fs/fuse/connections/<N>/` — `stat -c %d <mountpoint>` is the mapping.

**GT-30 — what the FUSE view does and does not carry.** xattrs yes
(`user.anas.gt="gtvalue1"`), **POSIX ACLs no** (only `user::/group::/other::` — the
named entry is invisible over FUSE though it IS in the archive). Hardlink partners
share a synthetic inode but report `Links: 1`. Symlinks read correctly, size 0.
Directory sizes 0. Awkward names (`mix [a] * b.txt`) render fine.

**GT-31 — after `kill -9` of the mount client the mount ENTRY REMAINS and access
fails FAST with `ENOTCONN`** — it does not hang:

```
findmnt  → /run/anas-gt-mnt /dev/fuse fuse ro,nosuid,…      (still listed)
ls       → ls: cannot access '/run/anas-gt-mnt': Transport endpoint is not connected   (exit 2)
stat -f  → cannot read file system information … Transport endpoint is not connected   (exit 1)
fusermount3 -u → exit 0, mount gone, directory usable again
```

So the daemon-start **stale-FUSE sweep is `findmnt -t fuse` + `fusermount3 -u`**, and
a killed client is the EASY case.

**GT-32 — with the PBS server STOPPED (port closed) the mount returns `EIO` in ~8 ms
and NEVER RECOVERS, even after the server comes back.**

```
ls   $M/part        → Input/output error   (exit 2)   elapsed=9 ms
stat $M/part/f7.bin → Input/output error   (exit 1)   elapsed=7 ms
head -c 1M $M/part/f7.bin → Input/output error        elapsed=8 ms
# … PBS restarted, mount still poisoned:
md5sum $M/part/f9.bin → Input/output error            elapsed=12 ms
```

**`stat -f` (statfs) still returns exit 0 in 8 ms**, and `ls` on the mount ROOT still
succeeds from cache. **statfs is NOT a liveness probe for a PBS FUSE mount** —
`mounts.ts`'s `timeout 2 stat -f` would report this dead mount as healthy. The honest
probe is a timeout-guarded read of a known entry, and the recovery is *remount*, not
retry.

**GT-33 — THE REAL HANG TRAP: a REACHABLE-BUT-BLACK-HOLED server produces D-state
readers that `timeout` CANNOT kill.** With the server running but `tcp dport 8007`
dropped (temporary nft table, removed after):

```
### timeout 5 ls $M/part  — 12 s later, 7 s after SIGTERM was due:
 368585 Ssl  futex_do_wait            proxmox-backup-client mount … /run/anas-gt-mnt --ns gtrestore
 368609 S    sigsuspend.isra.0        timeout 5 ls /run/anas-gt-mnt/part
 368611 D    request_wait_answer      ls /run/anas-gt-mnt/part
  ==> 'timeout 5' fired at 5 s and the child is STILL ALIVE in D state.
  outstanding FUSE requests: 1
```

The recovery ladder, measured:

```
fusermount3 -u   → fusermount3: failed to unmount …: Device or resource busy   (exit 1, 2 ms)
fusermount3 -uz  → exit 0 (9 ms); findmnt is clean BUT the reader is STILL stuck in D
echo 1 > /sys/fs/fuse/connections/61/abort  → exit 0 (1 ms)
  processes after the abort:
    (none - reader, timeout and mount client all released)
```

`/sys/fs/fuse/connections/<N>/waiting` reports the outstanding-request count (`1`
while stuck) — a real health signal. **`abort` is the only lever that frees a stuck
reader.** (`<N>` = `stat -c %d <mountpoint>`, captured at mount time, because after a
lazy unmount the mountpoint is gone.)

---

## 5. `.img` archives

**GT-34 — a REGULAR FILE is accepted as an `.img` source. No `losetup` is needed.**

```
$ proxmox-backup-client backup lun.img:/gtbackup/images/lun.raw --ns gtrestore --backup-id gtimg
Upload image '/gtbackup/images/lun.raw' to '…' as lun.img.fidx
lun.img: had to backup 12 MiB of 512 MiB (compressed 536 B) in 0.54 s (average 22.176 MiB/s)
lun.img: backup was done incrementally, reused 500 MiB (97.7%)
```

A zvol device path works identically (`vol.img:/dev/zvol/gtbackup/vol1`), and both can
sit in one snapshot (`Upload image …` blocks in argv order, one `Duration`/`End Time`).

**GT-35 — the per-`.img` output is TWO lines, and the `reused` line appears even on a
FIRST run.** The 97.7% above is datastore-wide chunk dedup (a 512 MiB sparse file is
mostly one zero chunk), **not** "unchanged since the last backup" — there was no
previous manifest. A parser must not present first-run `reused` as incremental reuse.

**GT-36 — `.img` uses 4 MiB fixed chunks; an unchanged image reports `0 B` but is
still READ IN FULL.**

```
run 2 (no change):    lun.img: had to backup 0 B of 512 MiB … in 0.56 s ; reused 512 MiB (100.0%)
run 3 (24 bytes changed at offset 0): had to backup 4 MiB of 512 MiB ; reused 508 MiB (99.2%)
```

**GT-37 — `--change-detection-mode=metadata` is a NO-OP for `.img` archives.** Run 4
with the flag produced byte-identical output shape to run 2: no `.mpxar`/`.ppxar`
split, no `Change detection summary`, `had to backup 0 B`. The flag is silently
ignored.

**GT-38 — the stored file is `<name>.img.fidx`; there is NO catalog and NO FUSE
mount for it.** `mount` refuses: `Error: use the 'map' command to map drive images`.

**GT-39 — ⚠ `restore` REFUSES EVERY EXISTING TARGET for an `.img`, including a block
device node — and `--overwrite` does not help.** This contradicts the phrasing in
`backup2.7`:

```
$ … restore <snap> lun.img /gtbackup/images/restored-b.raw       # existing regular file
Error: unable to create target file "/gtbackup/images/restored-b.raw" - File exists (os error 17)   exit 255
$ … restore <snap> lun.img /gtbackup/images/restored-b.raw --overwrite true
Error: unable to create target file "…" - File exists (os error 17)                                  exit 255
$ … restore <snap> vol.img /dev/zvol/gtbackup/vol1               # the zvol symlink
Error: unable to create target file "/dev/zvol/gtbackup/vol1" - File exists (os error 17)            exit 255
$ … restore <snap> vol.img /dev/zd16                             # the resolved device node
Error: unable to create target file "/dev/zd16" - File exists (os error 17)                          exit 255
```

The device was left completely untouched in every case (the pre-restore wipe pattern
was still at offset 0). So **the client never writes "into" a device node and never
unlinks/replaces the path — it simply refuses.**

**GT-40 — the working paths to a block device are `restore … -` (stdout) or
`map` + `dd`.** Both proven:

```
$ … restore <snap> vol.img - --ns gtrestore > /dev/zvol/gtbackup/vol1
restore complete (512 MiB processed in 0.6s, average 802.99 MiB/s)     exit 0
  head24: ANAS-GT-IMG-ZVOL-HEAD-v1     tail24: ANAS-GT-IMG-ZVOL-TAIL-v1
```

The progress/completion line still goes to **stderr** when stdout is the device
(verified with `1>/dev/null`). Restoring an `.img` to a **fresh file path** works and
produces a **sparse** file (512 MiB apparent, 5.5 K allocated).

**GT-41 — `map` / `unmap`.**

```
$ … map <snap> vol.img --ns gtrestore
Image 'root@pam!anas-test@localhost:8007:anastest-store:host/gtimgboth/…Z/vol.img' mapped on /dev/loop1
$ losetup -a
/dev/loop1: [0060]:1 (/run/pbs-loopdev/root\x40pam\x21anas\x2dtest\x40localhost\x3a8007\x3a…-vol.img)
$ blockdev --getsize64 /dev/loop1 → 536870912       $ blockdev --getro /dev/loop1 → 1
$ dd if=/dev/zero of=/dev/loop1 … → dd: error writing '/dev/loop1': Operation not permitted
```

The mapped device is **read-only** and carries whatever the image carries — an ext4
image is fully recognized and mountable:

```
$ blkid -p /dev/loop0
/dev/loop0: LABEL="GTIMGFS" UUID="de48…" VERSION="1.0" FSBLOCKSIZE="1024" BLOCK_SIZE="1024" FSLASTBLOCK="262144" FSSIZE="268435456" TYPE="ext4" USAGE="filesystem"
$ mount -o ro /dev/loop0 /run/anas-gt-imgmnt   → exit 0
```

`unmap <dev|loopN|archive-name>` releases one; **`unmap` with NO argument lists all
current mappings and force-cleans leftovers** (`Nothing mapped.` when empty, exit 0) —
that is the daemon-start sweep for block restores. A raw image with no filesystem
signature gives `blkid` exit 2 and no output.

**GT-42 — SIZE MISMATCH: the client offers NO protection and the failure is
destructive.** 512 MiB image onto a 256 MiB zvol:

```
$ … restore <snap> vol.img - --ns gtrestore > /dev/zvol/gtbackup/vol2
Error: No space left on device (os error 28)     exit 255
# …and the first 256 MiB of the image WERE written: the device's head is now the image's head.
$ dd if=/dev/loop1 of=/dev/zvol/gtbackup/vol2 bs=1M conv=notrunc
dd: error writing '/dev/zvol/gtbackup/vol2': No space left on device      exit 1
```

The reverse (512 MiB image onto a 1 GiB zvol) succeeds, exit 0 — and **leaves the
tail beyond the image length untouched** (the pre-existing marker at offset 1e9
survived). `backup2.7`'s "an image larger than the current target is refused with
both sizes" must be an **ANAS pre-check**; nothing below us does it.

---

## 6. Zvol snapshot devices (`snapdev`)

**GT-43 — default `snapdev` is `hidden` (source `default`) and the snapshot node does
not exist.** `ls /dev/zvol/gtbackup/vol1@s1` → `No such file or directory`, `test -e`
→ 1, even after `udevadm settle`.

**GT-44 — the node appears within ~10 ms of `zfs set snapdev=visible` returning.**
Measured: `zfs set` returned at **44 ms**, the node was present at **54 ms** (first
50 ms poll), `udevadm settle` returned at **64 ms**. Removing it (`snapdev=hidden`)
took **33 ms**. A poll-with-`udevadm settle` loop is correct and cheap; do not assume
the node is there the instant `zfs set` returns.

**GT-45 — the snapshot device is `/dev/zvol/<pool>/<vol>@<snap>` → `/dev/zdNN`, hard
read-only** (`blockdev --getro` = 1; opening for write → `Read-only file system`) and
it is a stable point-in-time view: after writing a new pattern to the live zvol, the
snapshot device still read the old head, and a second `.img` backup of it reported
`had to backup 0 B … reused 512 MiB (100.0%)`.

**GT-46 — `zfs set snapdev=hidden` does NOT restore the original state.** It leaves
`source=local` where there was `source=default`. Only `zfs inherit snapdev <vol>`
restores `default`. Guest philosophy: the set-use-restore cycle must use `zfs inherit`
when the property was inherited before, and `snapdev` is per-dataset (a child zvol
does not pick up a sibling's local value).

---

## 7. Metadata change-detection continuity — live root → snapshot root

**This is the 10 TB question, and the answer is: continuity HOLDS. No re-read.**
Full transcript: `change-detection-continuity.txt`. Tree: a dedicated dataset
`gtbackup/cdm` with 2000 files / 3.937 MiB payload, same `--backup-id gtcdm` and same
archive name `cdm.pxar` throughout.

**GT-47 — inode numbers are IDENTICAL between the live path and `.zfs/snapshot/<s>/`;
only `st_dev` differs.**

```
7 60 /gtbackup/cdm/tree/a/f1.bin
7 61 /gtbackup/cdm/.zfs/snapshot/s1/tree/a/f1.bin
2 60 /gtbackup/cdm/tree
2 61 /gtbackup/cdm/.zfs/snapshot/s1/tree
mtimes identical to the nanosecond.
```

**GT-48 — run 3 (archive root switched to the ZFS snapshot) reported the tree fully
unchanged and uploaded ZERO bytes** — the client's metadata reference does not
include `st_dev`, so the previous `.mpxar` still matched:

```
### RUN 2 — live path, unchanged
 - 2000 total files (0 hardlinks)
 - 2000 unchanged, reusable files with 3.937 MiB data
cdm.mpxar: had to backup 267.813 KiB of 267.813 KiB …
### RUN 3 — SAME backup-id + archive name, root = /gtbackup/cdm/.zfs/snapshot/s1/tree
Using previous index as metadata reference for 'cdm.mpxar.didx'
Change detection summary:
 - 2000 total files (0 hardlinks)
 - 2000 unchanged, reusable files with 3.937 MiB data
 - 0 changed or non-reusable files with 0 B data
cdm.ppxar: reused 3.937 MiB from previous snapshot for unchanged files (4 chunks)
cdm.ppxar: had to backup 0 B of 3.937 MiB (compressed 0 B) …
cdm.mpxar: had to backup 0 B of 267.813 KiB (compressed 0 B) …
```

**GT-49 — continuity is bidirectional and survives snapshot rotation.** Run 4 from a
*different* snapshot `s2` (one file touched) reported `1999 unchanged / 1 changed`,
and run 5 back on the LIVE path reused 100%. Switching the source root — live→snap,
snap→snap, snap→live — costs nothing.

**GT-50 — default mode is even more indifferent.** D1 (live) → D2 (live, unchanged)
→ D3 (`.zfs/snapshot/s3/tree`) all `had to backup 0 B of 4.137 MiB … reused 4.137 MiB
(100.0%)`. Content-defined chunking never looked at the path.

**GT-51 — `.zfs/snapshot/<s>/` is reachable even with `snapdir=hidden`** (the default;
`zfs get snapdir` = `hidden`), and each snapshot is its own mount:
`findmnt -T /gtbackup/cdm/.zfs/snapshot/s1` → `SOURCE=gtbackup/cdm@s1 FSTYPE=zfs`.
That is the automount `backup2.2`'s nested-filesystem detection must exclude.

---

## 8. AHR / btrfs nested subvolumes under a read-only snapshot

**GT-52 — a btrfs read-only snapshot does NOT recurse into nested subvolumes; it
leaves an EMPTY PLACEHOLDER DIRECTORY.** `@data` had a nested subvolume `photos`
(3 files) and a plain `plaindir`:

```
$ btrfs subvolume snapshot -r /mnt/gtbtrfs/@data /mnt/gtbtrfs/snap1
$ ls -A /mnt/gtbtrfs/snap1/photos    → (0 entries)
$ find /mnt/gtbtrfs/snap1
d /mnt/gtbtrfs/snap1        d /mnt/gtbtrfs/snap1/photos     ← empty
d /mnt/gtbtrfs/snap1/plaindir   f …/plaindir/p.txt   f …/top.txt
$ btrfs subvolume show /mnt/gtbtrfs/snap1/photos
ERROR: Not a Btrfs subvolume: Invalid argument
```

**GT-53 — `stat -c %d` (st_dev) per entry:**

```
65 /mnt/gtbtrfs           (fs root, subvolid=5)
66 /mnt/gtbtrfs/@data     67 /mnt/gtbtrfs/@data/photos    66 /mnt/gtbtrfs/@data/plaindir
68 /mnt/gtbtrfs/snap1     64 /mnt/gtbtrfs/snap1/photos    68 /mnt/gtbtrfs/snap1/plaindir
```

Every subvolume gets its own `st_dev`; the **empty placeholder reports the fs-root
`st_dev` (64) and inode 2**, so it looks like yet another filesystem to any
`--one-file-system` walker. A plain subdirectory shares its subvolume's `st_dev`.

**GT-54 — the client logs `skipping mount point: "photos"` for the placeholder and
stores it as an EMPTY DIR** — for the live subvolume AND for the read-only snapshot:

```
Upload directory '/mnt/gtbtrfs/snap1' … as btr.pxar.didx
skipping mount point: "photos"
$ catalog dump …
d "./btr.pxar.didx"   d "./btr.pxar.didx/photos"   d "./btr.pxar.didx/plaindir"
f "./btr.pxar.didx/plaindir/p.txt" 15 …   f "./btr.pxar.didx/top.txt" 15 …
```

The line is on **stderr**, quoted, and the path is relative to the archive root.

**GT-55 — ⚠ `--all-file-systems` RESCUES the live subvolume but CANNOT rescue the
read-only snapshot.** Live `@data` with `--all-file-systems` stored all of
`photos/one.jpg`, `photos/two.jpg`, `photos/sub/three.jpg`. The same flag on `snap1`
stored the same 652 B as without it — **there is nothing under the placeholder to
recurse into.** Taking one `btrfs subvolume snapshot -r` of an AHR `@data` and backing
that up therefore **silently loses every nested subvolume, and no client flag can fix
it.**

---

## 9. Restore failure taxonomy, progress, and interruption

**GT-56 — restore failure strings and exit codes** (`restore-failure-taxonomy.txt`,
all exit 255 unless noted):

| cause | verbatim | distinguishable? |
|---|---|---|
| missing snapshot timestamp | `Error: snapshot host/gtrestore/2020-01-01T00:00:00Z does not exist.` | — |
| missing GROUP | `Error: snapshot host/nosuchgroup/…Z does not exist.` | **NO** — same string |
| missing NAMESPACE | `Error: snapshot host/gtrestore/…Z does not exist.` | **NO** — same string |
| archive name not in the snapshot | `Error: archive not found in manifest` | yes |
| unknown archive suffix | `Error: failed to parse archive type for 'data.zzz'` | yes |
| pattern matches nothing | *(silence)* — **exit 0**, nothing restored | **no signal at all** |
| target is a regular file | `Error: error extracting archive - failed to initialize extractor: error creating directory "/gtbackup/ftfile": ENOTDIR: Not a directory` | yes |
| target filesystem read-only | `Error: error extracting archive - … error at entry "acl-xattr.txt": failed to extract file: failed to create file "acl-xattr.txt": EROFS: Read-only file system` | yes, but only at the FIRST FILE — the target dir was entered fine |
| PBS down | `Error: client error (Connect)` + `Caused by: error connecting to https://localhost:8007/ - tcp connect error: Connection refused (os error 111)` | yes |
| token without rights | `Error: no permissions on /datastore/anastest-store/gtrestore` | yes — **different wording from the backup/list path** (`permission check failed - missing …`) |

**GT-57 — ⚠ a GROUP path with no timestamp SILENTLY restores the LATEST snapshot:**
`restore host/gtrestore data.pxar <target>` → exit 0. ANAS must always pass a full
`type/id/timestamp`; a truncated one is not an error, it is a different restore.

**GT-58 — pbc 4.2.5 CAN separate dns / tcp / tls — this supersedes the 16.1 finding
(which was captured on 4.2.3).** The `Error: client error (Connect)` line is still
identical, but a `Caused by:` block now follows it:

```
dns      Caused by: error connecting to https://nosuchhost.invalid:8007/ - dns error: failed to lookup address information: Name or service not known
refused  Caused by: error connecting to https://localhost:8007/ - tcp connect error: Connection refused (os error 111)
route    Caused by: error connecting to https://192.0.2.1:8007/ - tcp connect error: deadline has elapsed
tls      Caused by: 0: error:0A000086:SSL routines:tls_post_process_server_certificate:certificate verify failed:…
         (preceded by the same WARNING: certificate fingerprint does not match expected fingerprint! block)
```

The daemon's own DNS+TCP probing is still the belt-and-braces answer, but it is no
longer *forced* by the client on 4.2.5.

**GT-59 — restore progress: irregular, CR-terminated, on STDERR, nothing for the
first ~6 s.** A 250 MiB archive rate-limited to 3 MB/s (87 s):

```
[+  5983 ms] progress 4% (12.409 MiB of 250.001 MiB in 6s, 2.084 MiB/s)
[+ 16154 ms] progress 17% (43.939 MiB of 250.001 MiB in 16.1s, 3.1 MiB/s)
[+ 36154 ms] progress 40% (101.305 MiB of 250.001 MiB in 36.1s, 2.868 MiB/s)
[+ 78875 ms] progress 86% (216.344 MiB of 250.001 MiB in 1m 18.8s, 2.693 MiB/s)
[+ 87547 ms] restore complete (250.001 MiB processed in 1m 27.5s, average 2.857 MiB/s)
```

STDOUT was empty. The interval **roughly doubles each time** (6 s, 16 s, 36 s, 79 s) —
it is not periodic, so a multi-hour restore emits only a handful of late lines; a job
UI must not treat silence as a stall. A pty changes nothing but the trailing `\r`
(`cat -v` shows `…MiB/s)    ^M`) — a parser must split on `\r` as well as `\n`.

**GT-60 — an interrupted restore leaves a partial tree with NO MARKER OF ANY KIND.**
After `kill -9` 20 s into the rate-limited restore:

```
-rw-r--r-- 1 root root 26214400 f1.bin      ← complete
-rw-r--r-- 1 root root 26214400 f10.bin     ← complete
-rw------- 1 root root  2129920 f2.bin      ← in flight
```

No temp names, no `.partial`, no hidden files, no xattrs. **The only signal is the
mode: pxar creates a file `0600` and chmods to the archived mode after the content is
written**, so an in-flight file is short AND `0600`. That is a heuristic, not a
contract — `backup2.6`'s "cancel leaves the dir labeled partial or removes it" must be
implemented entirely by ANAS. `SIGTERM` behaves the same (exit 143 / 137, no cleanup).

**GT-61 — PBS dying mid-restore names the entry it died on:**

```
progress 17% (43.939 MiB of 250.001 MiB in 16.1s, 3.09 MiB/s)
HTTP/2.0 connection failed
Error: error extracting archive - encountered unexpected error during extraction: error at entry "f2.bin": failed to extract file: failed to copy file contents: connection closed because of a broken pipe
### exit=255
```

**GT-62 — `--rate` limits TRANSFERRED bytes, not logical bytes.** A 512 MiB sparse
`.img` restore with `--rate 3MB` finished in 0.4 s (only ~12 MiB of real chunks). Any
"time remaining" estimate built on archive size will be wrong for sparse images.

---

## Design impacts — answering the ⚠ notes in `backup2.2`–`backup2.7`

### `backup2.2` — nested filesystems visible, never silent
- **Detection must use `st_dev`, not just `findmnt`.** GT-53: a btrfs nested
  subvolume, and even the *empty placeholder* left by a ro snapshot, has its own
  `st_dev` but **no `findmnt` line** (it is not a mount). `findmnt` submount
  enumeration alone will miss every btrfs subvolume. The authoritative detector is a
  `st_dev != parent's st_dev` walk, with `findmnt` used to *name* what was found.
- The `.zfs/snapshot/<s>` automounts the story says to exclude are real
  `findmnt` entries with `FSTYPE=zfs` and `SOURCE=<dataset>@<snap>` (GT-51) — easy to
  filter on the `@` in SOURCE.
- The log-parse fallback is one stderr line per skip:
  `skipping mount point: "<archive-relative path>"` (GT-54), quoted, unescaped.
- `--all-file-systems` is the right mapping for `includeNested: all` **on a live
  root** (GT-55) — but see the `backup2.3` correction below.

### `backup2.3` — snapshot-consistent backups
- **The story's key assumption is CONFIRMED, not refuted: metadata-mode continuity
  survives the live→snapshot root switch** (GT-47/48/49). Inodes are preserved,
  `st_dev` is not part of the reference, and the first snapshot-mode run reuses 100%.
  **There is no 10 TB re-read.** The same is true in default mode (GT-50) and in the
  reverse direction. The toggle is safe to ship.
- **⚠ NEW, and it breaks the AHR half of the story: a btrfs `subvolume snapshot -r`
  of `@data` silently drops every nested subvolume, and `--all-file-systems` cannot
  recover it** (GT-52/55). The ZFS "recursive snapshot → one archive root per dataset"
  expansion has an exact btrfs counterpart that is **mandatory, not optional**: AHR
  must snapshot each nested subvolume and expand to one archive root per subvolume, or
  refuse the source with a named reason. A single `@data` snapshot is a silent data
  loss.
- `.zfs/snapshot/<s>/` is reachable with `snapdir=hidden` (GT-51) — no property change
  needed for ZFS sources.

### `backup2.4` — `img` archives
- **"regular-file `.img` … else `losetup -r`" — the `losetup` fallback is not
  needed.** A regular file is accepted directly (GT-34).
- **"metadata mode can never skip it: the wizard states 'full read every run'" is
  right for the wrong reason.** `--change-detection-mode` is a **no-op** for `.img`
  (GT-37) — there is no metadata/payload split at all. The full read happens in
  *both* modes (GT-36); the wizard should say the mode setting does not apply to image
  archives, not that metadata mode "cannot skip".
- Zvol snapshot device: `snapdev=visible` + poll/`udevadm settle` is correct, and the
  node arrives ~10 ms after `zfs set` returns (GT-44). **Restore the property with
  `zfs inherit`, not `zfs set …=hidden`** (GT-46).
- Progress unit for the job runner: two stderr lines per image
  (`<name>.img: had to backup …` and `<name>.img: backup was done incrementally,
  reused …`), and **the `reused` line is meaningless on a first run** (GT-35).

### `backup2.5` — the picker
- **The picker must emit `/`-anchored, escaped patterns.** An unanchored
  `alpha.txt` restores three files at three depths (GT-18); `bracket[1].txt`
  unescaped restores **nothing** (GT-22). Escape `\ * ? [ ]`; leave spaces alone.
- Two backends are viable for the archive side, and the safe one is not FUSE:
  **`catalog shell` is a scriptable, non-FUSE browser** (`ls`, `stat`, `find`,
  `restore --pattern`) that works on default and metadata archives (GT-8). Its network
  waits happen in a process ANAS spawns and can kill — no D-state, no kernel queue.
- An **empty directory cannot be selected** for restore at all (GT-21); the picker
  should grey it out or the restore will silently produce nothing.

### `backup2.6` — file restore
- **In-place restore = `--allow-existing-dirs --overwrite`** (GT-11). Neither flag
  alone is enough, and `--overwrite` does *not* imply `--allow-existing-dirs`.
  **A single picked file in a subdirectory ALSO needs `--allow-existing-dirs`**
  (GT-26) — so the story's "a single explicitly picked file restored in place is a
  checkbox" still ships the dir flag.
- **In-place restore is a merge, never a sync** (GT-12) — the UI must not imply the
  target will be made to match the snapshot.
- **Side-by-side default: no flags needed and the directory need not exist** (GT-15).
- **⚠ The FUSE hang trap is WORSE than the story states, and `mounts.ts`'s guard does
  not transfer.** A black-holed server produces `D`-state readers that `timeout N`
  **cannot kill** (GT-33); `fusermount3 -u` returns EBUSY and a lazy unmount detaches
  the mount without freeing the reader. The only lever is
  `echo 1 > /sys/fs/fuse/connections/<st_dev>/abort`. And `stat -f` — the exact probe
  `mounts.ts` uses — **returns 0 on a dead PBS mount** (GT-32). If the daemon ever
  browses over FUSE it must (a) do it in a child process it can abandon, (b) record
  the connection id at mount time, (c) treat `EIO` as "remount", never "retry", and
  (d) sweep with `abort` before `fusermount3 -u`. Preferring `catalog shell` sidesteps
  all of it.
- **A hardlink's second name cannot be restored alone** — `ENOENT`, exit 255,
  the whole job fails (GT-25). The picker must add the partner or the daemon must
  detect `h` entries in `catalog dump` and expand the selection.
- **The space check needs no download**: `snapshot files[].size` is the logical
  archive size (GT-4).
- **A wrong selection is a silent success** (GT-24) — the daemon must verify what
  landed and report "0 files restored" itself.
- **Cancel/crash leaves no marker** (GT-60) — the "partial" label is entirely ANAS's
  to write, and the only forensic hint is a short `0600` file.
- **Always pass a full snapshot path**; a bare group means "latest" (GT-57).

### `backup2.7` — LUN image restore
- **⚠ The story's "zvol: into the device or `map` + `dd`" is half wrong: `restore`
  onto an existing path — file OR device — is REFUSED, `--overwrite` included**
  (GT-39). The two real paths are `restore … -` piped/redirected to the device
  (GT-40) or `map` + `dd` (GT-41). For the file kind, "`restore` to the path" only
  works if the path does **not** exist, i.e. restore beside it and rename, or stream
  to stdout over it.
- **The size guard is entirely ANAS's job and it must be a pre-check, because the
  failure is destructive**: a too-large image writes until `No space left on device
  (os error 28)` and leaves the target half-overwritten (GT-42). Restoring a *smaller*
  image succeeds and leaves stale tail bytes — also worth naming in the UI.
- The `map` device is read-only (GT-41), so `map` + `dd` is a safe read source and
  `blkid`/`mount -o ro` on it gives a cheap "is this the filesystem you expected?"
  confirmation before overwriting a LUN.
- `unmap` with no argument is the daemon-start sweep for leftover mappings (GT-41).

---

## Open questions

1. **Escaping completeness.** `\`-escaping was proven for `*` and `[`; a filename
   containing a literal backslash, a `?`, or a `"` was not tested. `catalog dump`
   quotes names but does not appear to escape them — a name with `"` may be
   unparseable from the dump (use `catalog shell`/FUSE for such trees).
2. **`catalog shell` under an unreachable server.** Its reads go over HTTP in a
   process we spawn, so it should be killable — but that was not measured against a
   black-holed server. Worth proving before choosing it over FUSE for `backup2.5`.
3. **Progress cadence at scale.** The doubling interval was measured over 87 s. What a
   6-hour restore actually emits (and whether the percentage granularity stays useful)
   is unknown.
4. **fd behaviour during restore.** 16.1 profiled fds during *backup*; restore was not
   profiled. Metadata-mode restores of very wide trees may or may not have the same
   `LimitNOFILE` sensitivity.
5. **`--prelude-target` / pxar v2.** Present in the help, untested; unknown whether
   ANAS-created archives ever carry a prelude.
6. **`change-owner` for the auth-switch case.** SURPRISE A (16.1) says a group is
   owned by an auth-id; `proxmox-backup-client change-owner` exists but was not
   exercised, so the recovery path for a task that switches auth style is still
   unproven.
7. **The 4.2.5 `Caused by:` block** (GT-58) suggests the 16.1 ruling "the daemon must
   do its own DNS+TCP probing" could be simplified. Not a change to make here — the
   fleet's client version floor would have to be settled first.
8. **AHR nested-subvolume expansion naming.** GT-55 forces per-subvolume archive
   roots for AHR; the deterministic-name scheme (`data` + `data__photos`) was designed
   for ZFS child datasets and has not been checked against btrfs subvolume paths that
   can nest arbitrarily deep.
