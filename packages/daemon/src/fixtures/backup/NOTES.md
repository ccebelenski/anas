# PBS file backup — ground-truth capture (story 16.1)

Captured on the disposable stunt PVE 9 node `192.168.200.50` (`anas-pve`), 2026-07-18/19.
Environment: `pve-manager/9.2.4`, kernel `7.0.14-4-pve`, Debian 13 (trixie),
`proxmox-backup-client 4.2.3-1` and `proxmox-backup-server 4.2.3-1` (installed
**on the stunt node itself** from the `pbs-no-subscription` trixie repo — coexists
with PVE fine, listens on `:8007`). **The operator's real PBS boxes
(10.0.0.96/10.0.0.97) were never touched.**

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
