# PBS file backup — ground-truth capture (story 16.1)

Captured on the disposable stunt PVE 9 node `192.168.200.50` (`anas-pve`), 2026-07-18/19.
Environment: `pve-manager/9.2.4`, kernel `7.0.14-4-pve`, Debian 13 (trixie),
`proxmox-backup-client 4.2.3-1` and `proxmox-backup-server 4.2.3-1` (installed
**on the stunt node itself** from the `pbs-no-subscription` trixie repo — coexists
with PVE fine, listens on `:8007`). **The operator's real PBS boxes
were never touched.**

These are the **exact bytes** `proxmox-backup-client` (pbc) produced. They exist to
drive the stage-2 parser/schema/verdict work for Epic 16 (PBS file backup). No parser
exists yet — reality first. Per the Epic 16 design ruling, **status is LOCAL-ONLY and
ANAS never polls the PBS server**, so there are deliberately NO snapshot-list/status
fixtures for the product path; the `snapshot list` / `catalog dump` calls here are
**ground-truth verification of MY test process only** (establishing what the excludes
and modes actually stored), never a pattern the product follows.

> **Test topology.** A dir-backed datastore `anastest-store` at `/testpool/pbs-store`,
> namespace `anastest`, on the same node. Both auth styles exercised: PAM password
> (`root@pam`) and an API token (`root@pam!anas-test`, DatastoreAdmin). Source trees
> were throwaway dirs under `/root` (removed after capture). All backups target
> `[anastest]:host/<backup-id>/<timestamp>`.

## PBS handles the live-proof stage reuses (left in place on the node)

- Datastore `anastest-store` (`/testpool/pbs-store`), namespace `anastest`, PBS on `:8007`.
- Fingerprint (sha256): `cc:b8:a0:35:60:b9:5f:77:10:e8:c2:62:ce:1e:dd:08:b8:03:0a:82:f7:62:09:bf:e8:f5:44:7e:8b:3e:2c:1d`
- **Secrets are in a root-only 0600 file on the node: `/root/anas-pbs-test-handles.txt`**
  (root password for `root@pam` password auth, and the token
  `root@pam!anas-test` + secret; a spare no-ACL token `root@pam!anas-noperm` for
  the permission-denied case). Disposable node, throwaway secrets.

---

## Fixture index

| File | What it is |
|------|------------|
| `backup-password-auth.txt` | Minimal 1-archive backup, **PASSWORD auth** (`PBS_REPOSITORY=user@realm@host:datastore`, `PBS_PASSWORD`=account password, `PBS_FINGERPRINT` pin). Full client output + exit 0. backup-id defaulted to the hostname. |
| `backup-token-auth.txt` | Same backup, **API TOKEN auth** (`PBS_REPOSITORY=user@realm!tokenname@host:datastore`, `PBS_PASSWORD`=token **secret**). Shows the group-**owner** refusal first, then success under the token's own backup-id. |
| `backup-multi-archive.txt` | One run, **3 named pxar archives** (`documents`/`pictures`/`music`) in one atomic group — per-archive upload sequencing, single catalog, single Duration/End Time. |
| `backup-backup-id.txt` | Explicit `--backup-id pictures` (operator-style logical id). Where the id shows up in output. |
| `backup-excludes.txt` | `--exclude` patterns (name-glob / path-anchored / dir) **+ a `.pxarexclude` file** in the tree, **verified by `catalog dump`** (what actually got stored). |
| `backup-change-detection-modes.txt` | Same tree twice in **default** and twice in **metadata** (`--change-detection-mode=metadata`) — the differing re-run reuse stats; the `mpxar`/`ppxar` file-set split. |
| `backup-fd-profile.txt` | fd-hoarding reproduction: 40 000-file tree, `/proc/<pid>/fd` sampled every 30 ms, default vs metadata × high/low/very-low `nofile` limits. |
| `backup-fd-warning-stream.txt` | The `resource limit for open file handles low: N` warning is **metadata-mode-only**; and the proof that **all pbc progress output is on STDERR**. |
| `backup-failure-taxonomy.txt` | 11 probes (baseline + unreachable / wrong-port / DNS-fail / bad-fingerprint / wrong-password / bad-token / revoked-token / no-permission / bad-datastore / bad-namespace), verbatim stderr + exit code, with a discriminator summary. |
| `timer-shape.txt` | Hand-written `anas-backup-test.service`+`.timer` (LimitNOFILE=1024, OnCalendar), `systemctl list-timers`, and `systemctl show` trimmed to the props `replication-units.ts` reads. Units removed after. |

### Retention / prune index (story 16.11, captured 2026-08-17)

Same stunt PBS harness (PBS 4.2.3), **datastore recreated dir-backed** after the
original `testpool` was lost — with a trap worth recording: `proxmox-backup-manager
datastore remove` **PURGES the path's ACLs**, so the token's permissions had to be
re-granted before anything worked again. The 11-snapshot history was synthetic,
built with backdated `--backup-time` in **OLDEST-FIRST order** because **PBS refuses
any backup older than the group's latest snapshot** (there is no backfill — build
history forward or not at all). The group `host/prune-gt2` (namespace `anastest`)
was **left in place** for the live-proof stage.

| File | What it is |
|------|------------|
| `prune-output-format-json.txt` | **The product path.** `prune host/prune-gt2 --ns anastest --dry-run --keep-last 2 --output-format json`, exit 0 → the structured array (`backup-id`, `backup-time` (unix s), `backup-type`, `keep`, `ns`, `protected`). Dry-run and REAL prune emit the SAME shape. This is the only prune output ANAS parses (Principle 13). |
| `prune-dry-run-keep-last.txt` | Default (no `--output-format`) `--dry-run --keep-last 3` — the box-drawing HUMAN table. Kept to document the path we deliberately never parse. |
| `prune-dry-run-buckets.txt` | Human table, bucket keeps (`--keep-daily/weekly/monthly`) — shows PBS's own bucketing (an old snapshot the buckets do not claim is removed). |
| `prune-real-buckets.txt` | The same buckets **for real** (no `--dry-run`), plus `--keep-yearly 1` — the yearly bucket rescues the 2025 snapshot the dry run above dropped. |
| `prune-noop-after.txt` | Re-running the same real prune: everything `keep` — prune is idempotent. |
| `verify-snapshot-list-after.txt` | `snapshot list --output-format json` after the real prune: 7 snapshots remain (the removed one is gone). Verification of the capture only — the product never polls the server for status. |
| `prune-no-keep-flags.txt` | `prune` with NO keep flags: keep-all, exit 0. Documents WHY ANAS never runs this path — an absent policy simply does not invoke prune. |
| `prune-missing-group.txt` | Missing GROUP → `Error: ENOENT: No such file or directory`, exit 255. |
| `prune-bad-namespace.txt` | Missing NAMESPACE → **byte-identical** `Error: ENOENT: No such file or directory`, exit 255. The two are INDISTINGUISHABLE — the verdict must say "group or namespace", never guess. |
| `prune-no-permission.txt` | Token without prune rights → `Error: permission check failed - missing Datastore.Modify\|Datastore.Prune on /datastore/<store>/<ns>`, exit 255 → the "lacks prune privileges" verdict, naming the privileges. |

### Nested-filesystem index (story backup2.2, captured 2026-08-25)

Read-only probes on the same stunt node (util-linux 2.41.5, GNU findutils 4.10.0,
btrfs-progs 6.14). Nothing on the node was created, modified or destroyed.

| File | What it is |
|------|------------|
| `nested-filesystems.txt` | **The st_dev walk.** `findmnt -J --target` for `/gtbackup`, `/gtbackup/cdm` and `/etc/pve`; `stat -c '%d %i %n'`; and the walk itself — `find -P <path> -xdev -maxdepth N -type d -printf '%D\t%p\n'` — proving that `-xdev` **prints the boundary directory carrying the NESTED filesystem's device number and does not descend into it** (`46 /gtbackup` … `49 /gtbackup/cdm`, nothing below). Also: the same walk WITHOUT `-xdev` (for contrast), the `-path … -prune` form used for remote mounts (the hang trap), the missing-path error (`exit=1`), and the `.zfs/snapshot` automount — invisible to the walk with the default `snapdir=hidden`, and a real `findmnt` row whose SOURCE carries an `@` once accessed (GT-51). The product-level example is here in full: `/etc` has exactly ONE nested filesystem, `/etc/pve` (pmxcfs, dev 55 vs 2049). |
| `findmnt-nested.json` | The node's whole `findmnt --json` tree, verbatim — the naming input for the walk above. Contains the zfs parent + child (`/gtbackup`, `/gtbackup/cdm`), PVE's `/etc/pve` fuse mount, an `autofs` placeholder, and the pseudo-filesystems the parser filters. |
| `btrfs-nested-subvol.txt` | *(backup2.1 capture, reused here)* The **`skipping mount point: "photos"`** line the parser keys on — real bytes, on stderr, quoted, archive-root-relative — plus `btrfs subvolume show` in both its forms (a real subvolume, and `ERROR: Not a Btrfs subvolume` for the empty placeholder a ro snapshot leaves). |

---

## 1. The env-var contract (both auth styles)

pbc composes its target from `PBS_REPOSITORY` (+ `--ns` for the namespace). The
control surface is exactly the env the client already speaks — ANAS generates it,
never a new one:

| var | password auth | token auth |
|-----|---------------|------------|
| `PBS_REPOSITORY` | `root@pam@localhost:anastest-store` | `root@pam!anas-test@localhost:anastest-store` |
| `PBS_PASSWORD` | the **account password** | the **token SECRET** (the uuid `value` from `user generate-token`) |
| `PBS_FINGERPRINT` | sha256 cert pin (same both) | same |
| namespace | `--ns anastest` (CLI flag, not in the repo string) | same |
| backup-id | `--backup-id <id>` (defaults to hostname) | same |

- **Token id syntax in the repository string is `user@realm!tokenname@host:datastore`.**
  The auth-id is `root@pam!anas-test`; the token-name part is `!anas-test`. Same slot
  as the username — the `!tokenname` suffix is what makes it a token.
- The client prints the target group as `Starting backup: [<namespace>]:host/<backup-id>/<ISO-timestamp>`
  and `Client name: <hostname>` (the hostname, independent of `--backup-id`). The
  backup **type is always `host`** for pbc file backups.
- `PBS_PASSWORD` carries the secret **via environment** for both styles — matches the
  design's "never argv, never a world-readable script" rule.

### SURPRISE A — a backup GROUP has an OWNER auth-id; a different auth-id is refused

The password run created `host/anas-pve` **owned by `root@pam`**. The token
(`root@pam!anas-test`) — *the same underlying user* — is a **distinct auth-id** and was
refused on that group:

```
Error: backup owner check failed (root@pam!anas-test != root@pam)   (exit 255)
```

It succeeded only under its **own** `--backup-id` (a new group it owns). **Design
impact:** a task's `(repo-auth-id, backup-id)` pair must be stable — you cannot switch a
task from password to token auth (or vice-versa) against an existing group without a
`change-owner` on the server. The registry's auth choice and a task's backup-id are
coupled; surfacing the owner mismatch (exit 255 + "backup owner check failed") as a
clear task error beats a cryptic 255. `snapshot list` JSON carries an `"owner"` field per
snapshot confirming this (seen: `tokentest` owned by `root@pam!anas-test`, everything else `root@pam`).

---

## 2. Multi-archive sequencing

`backup-multi-archive.txt`: three `name.pxar:/path` args in one invocation → one atomic
snapshot. Output is **one `Upload directory ... as <name>.pxar.didx` + one stats line per
archive, in argv order**, then a **single** `Uploaded backup catalog` + `Duration` +
`End Time`. Per-archive stats line shape (the job-progress unit):

```
<name>.pxar: had to backup 82.957 KiB of 82.957 KiB (compressed 81.043 KiB) in 0.01 s (average 13.322 MiB/s)
```

Archive **names, paths and backup-id are explicit config** (mirrors the design). The
snapshot then contains `<name>.pxar.didx` per archive + `catalog.pcat1.didx` + `index.json.blob`.

---

## 3. Change-detection modes — the re-run stats differ sharply

**This is the job-progress parsing center.** Same unchanged tree, second run:

- **Default (data/block)** mode — no per-file detail, whole-archive dedup:
  ```
  cdm.pxar: had to backup 0 B of 193.701 KiB (compressed 0 B) in 0.00 s (average 0 B/s)
  ```
- **Metadata** mode — a full **`Change detection summary`** block + per-archive reuse:
  ```
  Using previous index as metadata reference for 'cdm.mpxar.didx'
  Change detection summary:
   - 12 total files (0 hardlinks)
   - 12 unchanged, reusable files with 192.188 KiB data
   - 0 changed or non-reusable files with 0 B data
   - 32 B padding in 1 partially reused chunks
  cdm.mpxar: had to backup 1.912 KiB ...
  cdm.ppxar: reused 192.219 KiB from previous snapshot for unchanged files (1 chunks)
  cdm.ppxar: had to backup 32 B of 192.25 KiB ...
  ```

**Archive file-set differs by mode** (parser must handle both):
- default → `<name>.pxar.didx` + `catalog.pcat1.didx`
- metadata → **`<name>.mpxar.didx` (metadata) + `<name>.ppxar.didx` (payload)**, **NO catalog**

First-run metadata prints two `<name>.mpxar`/`<name>.ppxar: had to backup ...` lines (the
`.ppxar` line can print **before** the `.mpxar` line — ordering is not archive-arg order,
so parse by the filename token, not position).

---

## 4. Excludes — verified against `catalog dump`

`backup-excludes.txt`. `--exclude` CLI patterns AND a `.pxarexclude` file both applied:

| pattern | kind | effect (confirmed) |
|---------|------|--------------------|
| `--exclude '*.key'` | name glob | `secret.key` gone |
| `--exclude '/build'` | **path-anchored to tree root** | root `build/` gone, but **`src/build/keep.c` KEPT** |
| `--exclude 'tmp'` | dir name | `tmp/` gone |
| `.pxarexclude`: `node_modules` | dir | `node_modules/` gone |
| `.pxarexclude`: `*.tmp` | glob | `data/cache.tmp` gone |

Two facts for the parser/config model:
- **`/`-anchored patterns anchor to the archive/tree root**, not "anywhere" — `/build`
  excludes only the top-level `build`. Un-anchored (`tmp`, `*.key`) match at any depth.
- The stored archive gains a synthetic **`.pxarexclude-cli`** entry — pbc records the
  CLI `--exclude` patterns *into* the archive (timestamp `1970-01-01`). A real
  `.pxarexclude` in the tree is **also stored verbatim** (guest philosophy: pbc never
  strips it — matches the design's "keep the dotfile working for hand-managed trees").
  ANAS-configured excludes live in task config and are passed as `--exclude`.

---

## 5. fd-hoarding (LimitNOFILE) — honest findings

Operator ground truth: pbc "runs out of file handles, worst in metadata mode." **At the
scale I could build here (40 000 files / 158 MB, fast loopback) I did NOT reproduce fd
exhaustion — I am saying so honestly, not fabricating a failure.** What I *did* observe:

- **fd count stayed flat and tiny — MAX 13 fds in EVERY case**, including default AND
  metadata mode, and even under `prlimit --nofile=256:256`. All six runs exited 0.
  Mechanism: pbc uploads over a **single multiplexed HTTP/2 connection** and (on fast
  loopback) releases source-file handles as fast as it opens them — the async read queue
  never backs up, so handles never accumulate. The operator's real trigger is almost
  certainly **far larger trees and/or a slow network link** where the metadata-mode read
  queue stalls behind uploads and open source handles pile up. Not reproducible on a
  fast local datastore at 40 k files.
- **pbc DOES self-identify a low limit — and only in METADATA mode.** With a low
  `nofile`, metadata runs print (see `backup-fd-warning-stream.txt`):
  ```
  resource limit for open file handles low: 1024
  resource limit for open file handles low: 256
  ```
  **Default mode NEVER prints this warning** (silent even at `nofile=256`). This
  **confirms metadata is the fd-sensitive path** and gives ANAS a cheap signal: if a
  task's output contains `resource limit for open file handles low:`, the LimitNOFILE is
  biting and should be raised for that task. The design's `LimitNOFILE=1024` default +
  per-task override is exactly the right knob; metadata-mode tasks are the ones that will
  want it raised on big trees.

### SURPRISE C — **all pbc progress output is on STDERR, not stdout**

Proven directly (`backup-fd-warning-stream.txt`): the run with `2>/dev/null` produced
**nothing** on stdout; the run with `1>/dev/null` produced the **entire** transcript
(`Starting backup`, `Upload directory`, per-archive stats, `Change detection summary`,
the nofile warning, `Duration`, `End Time`). **Design impact — load-bearing:** the job
runner MUST capture **stderr** for progress parsing. stdout is used only for
`--output-format json` on the *query* subcommands (`snapshot list`), which the product
doesn't call.

---

## 6. Failure taxonomy → `POST /v1/backup/repos/test` verdicts

`backup-failure-taxonomy.txt`. **Every failure exits 255** (124 only if `timeout` fires
on a genuinely black-holed host — none of these hung; connect failures return fast). The
**verbatim `Error:` string is the sole discriminator.** Probe = `snapshot list --ns ...`
(needs tcp+tls+auth+datastore+namespace).

| DESIGN verdict | trigger | verbatim client message | distinguishable? |
|----------------|---------|--------------------------|------------------|
| **dns** | unresolvable host | `Error: client error (Connect)` | **NO — identical to tcp/route** |
| **tcp** | closed port / unreachable IP (RFC5737) | `Error: client error (Connect)` | **NO — identical to dns** |
| **tls-fingerprint** | pin byte altered | `WARNING: certificate fingerprint does not match expected fingerprint!` … `certificate validation failed - Certificate fingerprint was not confirmed.` (last line still `Error: client error (Connect)`) | **YES** (the fingerprint WARNING lines) |
| **auth** (password) | wrong password | `Error: permission check failed.` | **YES** |
| **auth** (token) | wrong secret | `Error: authentication failed` | **YES** — but bad-secret vs **revoked** are **identical** |
| **auth** (token) | revoked/deleted token | `Error: authentication failed` | same string as bad secret |
| **permission** | valid token, no ACL | `Error: permission check failed - missing Datastore.Audit\|Datastore.Backup on /datastore/anastest-store/anastest` | **YES** (the `- missing <priv> on <path>` suffix) |
| **datastore** | nonexistent datastore | `Error: no such datastore 'nosuchstore'` | **YES** |
| **namespace** | nonexistent namespace | `Error: ENOENT: No such file or directory` | **YES** (but generic ENOENT wording) |

**Load-bearing consequences for the verdict engine:**
- **pbc cannot tell dns from tcp from route** — all three are `client error (Connect)`.
  To render the design's separate **dns / tcp** verdicts the daemon must do its **own**
  DNS resolve + TCP connect (same lesson as Epic 18's mount-test), then only fall to pbc
  for tls/auth/datastore/namespace. (This mirrors the mounts fixture's finding that the
  transport layer collapses distinct causes into one message.)
- **Password-auth vs token-auth report auth failure DIFFERENTLY**: wrong password →
  `permission check failed.`; wrong/revoked token → `authentication failed`. The verdict
  code must match both, keyed on the repo's auth style.
- **`permission check failed.` (wrong password, trailing period, no detail)** vs
  **`permission check failed - missing … on …` (token no-ACL)** — the presence of the
  `- missing` suffix separates "bad credential" from "authenticated but unauthorized".
- **Revoked and wrong-secret tokens are indistinguishable** (`authentication failed`
  both) — the test can't tell the user "your token was revoked" vs "wrong secret".

---

## 7. Timer/service shape (`timer-shape.txt`)

Hand-written `anas-backup-test.service` + `.timer` (then removed). Confirms the
replication-store pattern transfers directly to backup:

- Service carries the `# X-ANAS-Task=<json>` comment (single source of truth, same idiom
  as `replication-units.ts`), `Type=oneshot`, and **`LimitNOFILE=1024`** — `systemctl
  show` confirms `LimitNOFILE=1024` / `LimitNOFILESoft=1024` applied.
- The props `replication-units.ts` reads are all present and behave identically:
  - timer `NextElapseUSecRealtime` — **prints a HUMAN date string**
    (`Sun 2026-07-19 02:00:00 UTC`), NOT microseconds, on PVE 9 / systemd — exactly the
    case the existing `timerNextRun()` already special-cases. `TimersCalendar` also
    carries the OnCalendar + next_elapse.
  - service `ActiveState` / `Result` / `ExecMainStatus` — a never-run oneshot shows
    `ActiveState=inactive`, `SubState=dead`, `Result=success`, `ExecMainStatus=0`; the
    timer shows `ActiveState=active`, `SubState=waiting`, `UnitFileState=enabled`. The
    service (no `[Install]`) is `UnitFileState=static`.
- `systemctl list-timers` renders `NEXT / LEFT / LAST / PASSED / UNIT / ACTIVATES` — same
  grid the Backup task view (16.4) will surface.

**Upshot:** Epic 16's task store can reuse `replication-units.ts` almost verbatim
(rename `anas-repl-` → `anas-backup-`, add `LimitNOFILE=` to the rendered service). No
new status mechanism needed; the LOCAL-ONLY status ruling is satisfied by the exact
systemd props the replication code already reads.

---

## 8. Retention / prune (story 16.11, 2026-08-17)

`proxmox-backup-client prune <group> [--ns <ns>] --keep-* N … [--dry-run]
--output-format json` — the ONLY prune ANAS runs, and only ever with the task's
own keep flags.

- **`--output-format json` is the contract**: exit 0 → an array of
  `{backup-id, backup-time, backup-type, keep, ns, protected}`. `keep:false` = the
  snapshot is (or would be) removed. **Dry-run and real prune emit the identical
  shape**, so ONE parser serves both the post-backup prune and the preview.
- **`backup-time` is unix SECONDS**, not ms and not an ISO string.
- **No keep flags = keep-all, exit 0** — a documented no-op. ANAS never invokes it:
  an absent policy means prune is not run at all.
- **ENOENT is ambiguous by design**: a missing group and a missing namespace both
  print `Error: ENOENT: No such file or directory` (exit 255), byte for byte. The
  verdict wording says "the backup group or the namespace" and stops there.
- **Permission**: `Error: permission check failed - missing
  Datastore.Modify|Datastore.Prune on /datastore/<store>/<ns>` (exit 255) — the
  credential authenticated but may not prune.
- **Prune is idempotent** (`prune-noop-after.txt`) and **only marks**: space is
  reclaimed by the datastore's garbage collection, which stays PBS-side. ANAS
  never surfaces or triggers GC.
- **Capture traps** (cost real time, recorded so they are not re-learned):
  `proxmox-backup-manager datastore remove` **purges the path's ACLs**; and PBS
  **refuses any backup older than the group's latest snapshot**, so a synthetic
  history must be built with `--backup-time` in OLDEST-FIRST order (no backfill
  exists).

---

## Summary of design-relevant takeaways

1. **Env contract is the control surface**: `PBS_REPOSITORY` (with `!tokenname` for
   tokens), `PBS_PASSWORD` (account password OR token secret), `PBS_FINGERPRINT`;
   namespace via `--ns`, group via `--backup-id`. Secrets via env, never argv.
2. **Capture STDERR for job progress** — pbc writes everything there; stdout is empty
   (SURPRISE C). Per-archive stats + the metadata `Change detection summary` block are
   the parse units.
3. **Two archive layouts by mode**: default = `.pxar` + catalog; metadata = `.mpxar` +
   `.ppxar`, no catalog. Metadata re-runs emit rich per-file reuse stats; default re-runs
   just say `0 B`.
4. **fd exhaustion did not reproduce at 40 k files/loopback** (max 13 fds, all runs OK
   even at nofile=256) — but the **`resource limit for open file handles low:` warning is
   metadata-mode-only**, confirming metadata is the sensitive path and giving ANAS a
   detectable signal. `LimitNOFILE=1024` default + per-task override is the right design.
5. **Failure verdicts come from the verbatim `Error:` string (all exit 255)**; but pbc
   **collapses dns/tcp/route into one `client error (Connect)`** — the daemon must do its
   own DNS+TCP probing for those verdicts. Bad-password vs token-no-perm are
   distinguishable; revoked vs wrong-secret token are not.
6. **A backup group has an owner auth-id** (SURPRISE A) — task auth style + backup-id are
   coupled and stable; switching auth against an existing group needs a server-side
   change-owner.
7. **1-second snapshot-timestamp resolution** (SURPRISE B) — rapid re-runs of one group
   collide with `backup timestamp is older than last backup.`; treat as benign too-soon.
8. **Task store = replication's `*-units.ts` pattern reapplied** (X-ANAS-Task comment,
   oneshot service + timer, `LimitNOFILE=1024`); the LOCAL-ONLY status reads the same
   systemd props the replication code already parses.

---

## Restore / mount / `.img` / continuity index (story `backup2.1`, captured 2026-08-25)

Same disposable stunt PBS, **but the node has been upgraded since 16.1**: the client
and server are now **`proxmox-backup-client` / `proxmox-backup-server` 4.2.5-1** (not
4.2.3), on PVE `pve-manager/9.2.11`, kernel `7.0.14-12-pve`, ZFS `2.4.3-pve1`,
`btrfs-progs v6.14`, `fuse3 3.17.2-3`. The write-up is
**`docs/BACKUP-RESTORE-GROUND-TRUTH.md`** (facts GT-1 … GT-62 with a "Design impacts"
section per story); this section is only the file index.

**Every file below is a REAL CAPTURE** — verbatim stdout+stderr of the commands named
in each file's header, unedited. **Nothing in this section is synthetic.** (The
earlier Epic 16 sections above still stand as written; the only correction this
capture forces on them is noted at the end.)

> **Test topology.** New namespace **`gtrestore`** in the existing dir-backed
> datastore `anastest-store`, reached with the existing API token
> `root@pam!anas-test`. All source trees lived on a **new file-backed pool
> `gtbackup`** (`/var/tmp/gtbackup.img`, 8 GiB, `acltype=posixacl xattr=sa`). The
> btrfs test used a temporary loop-backed volume (`/var/tmp/gtbtrfs.img`) that was
> destroyed afterwards. A temporary nft table `inet anasgt` (dropping tcp dport 8007)
> was created and removed by the black-hole script only.

### Text captures

| File | What it is |
|------|------------|
| `restore-flag-matrix.txt` | **The in-place restore ladder.** 14 probes: no flags / `--allow-existing-dirs` / `--overwrite-files` / `--overwrite` / the three specific `--overwrite-*` / `--ignore-*`, each against a freshly drifted tree, with the full tree state after. Establishes that **`--allow-existing-dirs --overwrite` is the minimal in-place pair** and that `--overwrite` does NOT imply `--allow-existing-dirs`. Also: restore into a new empty dir, into a non-existent dir, and the archive-name suffix rules. |
| `restore-ignore-flags.txt` | `--ignore-acls` / `--ignore-xattrs` / `--ignore-ownership` / `--ignore-permissions` against a **fresh** target, with `ls -ln` + `getfacl` + `getfattr` after each. |
| `restore-pattern-matrix.txt` | **`--pattern` semantics.** 27 probes (anchoring, `*` vs `**` vs `?`, char classes, directories, the empty dir, escaping `*`/`[`/space, multiple patterns, no match) + 11 disambiguation probes + a 7-probe capture over three files all named `alpha.txt` at three depths that proves **unanchored patterns match a path SUFFIX at any depth**. |
| `restore-failure-taxonomy.txt` | 11 restore failure probes (missing snapshot/group/namespace/archive, bad suffix, no-match pattern, target-is-a-file, read-only target, server down, no-permission token) with verbatim `Error:` strings and exit codes; plus the 4.2.5 connect-error probes showing the **new `Caused by:` block that separates dns / tcp-refused / route / tls** (this supersedes the 16.1 "indistinguishable" finding, which was captured on 4.2.3). |
| `restore-progress.txt` | The progress output of a rate-limited (3 MB/s) 250 MiB restore, timestamped per line, plus the same run under a pty with `cat -v` so the trailing `\r` is visible. Progress is on **stderr**, `\r`-terminated, and the interval **doubles** (6 s, 16 s, 36 s, 79 s) rather than being periodic. |
| `restore-interrupted.txt` | `kill -9`, `SIGTERM`, and **PBS stopped mid-restore**, each with the partial target listed afterwards. Proves there is **no marker of any kind** on a partial restore — the only hint is that an in-flight file is short and mode `0600`. |
| `snapshot-list-and-catalog.txt` | The point-in-time picker's read: `snapshot list` (namespace form, group form, human table, json-pretty), `list`, `snapshot files`, and `catalog dump` — including `catalog dump --output-format json` being **rejected outright**. |
| `catalog-shell-and-manifest.txt` | Proof that `catalog dump` writes to **stderr** (0 bytes on stdout, 971 on stderr); **`catalog shell` driven non-interactively over a pipe** (`ls`/`find`/`select`/`restore-selected`/`stat`) — a complete non-FUSE archive browser; the raw `index.json` manifest; in-place single-file restores; and `catalog shell`/`mount` across default / metadata / `.img` archives. |
| `fuse-mount-lifecycle.txt` | `mount` daemonizing (PPID 1), the `findmnt` line and mount options, what the FUSE view carries (xattrs yes, **POSIX ACLs no**, hardlinks report `Links: 1`), clean `fusermount3 -u`, and `kill -9` of the client → stale mount that fails fast with `Transport endpoint is not connected`. |
| `fuse-server-stopped.txt` | The mount with the PBS server **stopped**: fast `EIO` (~8 ms), and it **never recovers** after the server returns. Includes the 2.5 KiB-archive run that was inconclusive (fully cached) and the 250 MiB run that settled it. Also shows `stat -f` returning **exit 0 on a dead mount** — the `mounts.ts` liveness probe does not transfer. |
| `fuse-hang-trap-blackhole.txt` | **The headline capture.** PBS running but `tcp dport 8007` dropped: `ls` goes to `D`/`request_wait_answer` and **`timeout 5` cannot kill it** (still alive 7 s after SIGTERM was due); `fusermount3 -u` → EBUSY; `fusermount3 -uz` detaches the mount but leaves the reader stuck; only `echo 1 > /sys/fs/fuse/connections/<st_dev>/abort` frees everything. |
| `img-backup.txt` | `.img` archives from a **regular sparse file** (accepted directly — no `losetup` needed) and from a **zvol device**, both in one snapshot; first-run vs unchanged vs 24-bytes-changed reuse lines (4 MiB fixed chunks); `--change-detection-mode=metadata` shown to be a **no-op** for images; `catalog dump` refusing an `.img` snapshot. |
| `img-restore-and-map.txt` | **`restore` refusing every existing `.img` target** — regular file, zvol symlink, and resolved `/dev/zdNN` — with `--overwrite` making no difference; the two paths that DO work (`restore … -` redirected onto the device, and `map` + `dd`); `map`/`unmap` incl. `unmap` with no argument as the sweep; `blkid -p` / `lsblk` / `mount -o ro` on a mapped ext4 image; and the **destructive** size-mismatch failure (`No space left on device`, target half-overwritten) in both directions. |
| `zvol-snapdev.txt` | `snapdev` default (`hidden`, node absent), `snapdev=visible` with the node appearing ~10 ms after `zfs set` returns (44 ms → 54 ms → `udevadm settle` at 64 ms), the node's read-only-ness, backing up a zvol **snapshot device** and proving it is a stable point-in-time view, and the fact that `zfs set snapdev=hidden` leaves `source=local` (only `zfs inherit` restores `default`). |
| `change-detection-continuity.txt` | **The 10 TB question, settled.** 2000-file dataset, same backup-id + archive name: live → live-unchanged → **root switched to `.zfs/snapshot/s1`** → same snapshot again → a second snapshot with one file touched → back to live; plus the same live→snapshot comparison in **default** mode, and the inode/`st_dev`/mtime comparison that explains it. Run 3 reports **`2000 unchanged, reusable files`** and **`had to backup 0 B`** — the metadata reference survives the root switch. |
| `btrfs-nested-subvol.txt` | The AHR shape on a loop-backed btrfs: subvol `@data` with a nested subvol `photos` and a plain dir; `btrfs subvolume snapshot -r` leaving **`snap1/photos` EMPTY**; `stat -c %d` per entry (the placeholder reports the fs-root `st_dev` and inode 2); the client's `skipping mount point: "photos"` line; and the proof that **`--all-file-systems` rescues the LIVE subvolume but cannot rescue the read-only snapshot**. |

### JSON captures (`--output-format json-pretty`, unedited)

| File | What it is |
|------|------------|
| `snapshot-list-group.json` | `snapshot list <type>/<id> --ns <ns>` — one group. Note there is **no `snapshot` field**: the caller composes `<backup-type>/<backup-id>/<RFC3339 backup-time>`. |
| `snapshot-list-namespace.json` | `snapshot list --ns <ns>` — every group in the namespace, same element shape, **not sorted by `backup-time`**. |
| `group-list.json` | `list --ns <ns>` — the group listing, whose `files` is an array of **strings** (vs objects in `snapshot list`). |
| `snapshot-files-pxar.json` | `snapshot files` for a default-mode pxar snapshot (`data.pxar.didx` + `catalog.pcat1.didx` + `index.json.blob`). |
| `snapshot-files-metadata.json` | The same for a metadata-mode snapshot (`cdm.mpxar.didx` + `cdm.ppxar.didx`, **no catalog file**). |
| `snapshot-files-img.json` | The same for an `.img` snapshot (`lun.img.fidx` + `vol.img.fidx`, `size` = the **full logical device size**). |
| `index-json-manifest.json` | The raw manifest, read with `restore <snap> index.json.blob -`. Carries a `csum` per file and `unprotected.chunk_upload_stats`; `index.json.blob` is **not** in its own `files` array. |

### Handles left on the node (unchanged from 16.1 unless noted)

- PBS `:8007`, datastore `anastest-store` (`/testpool/pbs-store`), namespaces
  `anastest` (16.1/16.11) and **`gtrestore` (new, backup2.1)**.
- **Secrets stay in `/root/anas-pbs-test-handles.txt` (0600, root-only)** — never in
  the repo. That file was updated with the 4.2.5 version note and the new namespace.
- Left in place for later stories: pool **`gtbackup`** (file-backed,
  `/var/tmp/gtbackup.img`) with `gtbackup/data` (the awkward-names source tree),
  `gtbackup/cdm` (2000-file continuity dataset + snapshots `s1`/`s2`/`s3`),
  `gtbackup/images/lun.raw` (512 MiB sparse image) and the zvol `gtbackup/vol1`
  (+ snapshot `@s1`); the `gtrestore` namespace's groups `gtrestore`, `gtdup`,
  `gtbig`, `gtimg`, `gtimgvol`, `gtimgboth`, `gtimgfs`, `gtsnapdev`, `gtcdm`,
  `gtcdmdef`, `gtbtrfs`, `gtbtrfslive`, `gtbtrfsall`, `gtbtrfssnapall`.
- Removed after the capture: the loop-backed btrfs (`/var/tmp/gtbtrfs.img`), all
  FUSE mounts, all `map` loop devices, the temporary nft table, and every restore
  target directory.

### Correction this capture forces on the sections above

**§3's shorthand "metadata → … **NO catalog**" is about the stored
`catalog.pcat1.didx` FILE only.** `catalog dump` and `catalog shell` both work fine on
a metadata-mode snapshot (they read the `.mpxar`) — see
`catalog-shell-and-manifest.txt`. And **§6's "pbc cannot tell dns from tcp from
route" was true on 4.2.3 but is no longer true on 4.2.5**, which appends a `Caused
by:` block naming `dns error:` / `tcp connect error: Connection refused` / `tcp
connect error: deadline has elapsed` — see `restore-failure-taxonomy.txt`. Neither
finding changes any shipped ruling; both are recorded so they are not re-derived.
