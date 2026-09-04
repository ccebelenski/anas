# 0.3.1 Remediation Plan

Source: full code review of everything changed in v0.2.12..v0.3.0 (2026-09-01), every finding
verified against the code. This plan is deliberately SEPARATE from docs/EPICS.md: it is a
defect-remediation release, not feature work. When 0.3.1 is authorized, its waves become the
release scope; nothing here adds features. Goal: clean up before the general 0.3.0 announcement.

Finding ids (U/K/D/R/M/C/B prefixes) are stable and referenced from the GitHub issues.

## Wave 1 — announcement blockers (HIGH) — fix before announcing 0.3.0

**Status: COMPLETE 2026-09-03** — #50 `71ea926`, #47 `f9093c0`, #48+#49 in the K1/K2 commit; every fix landed with tests demonstrated to fail on the old code.

| id | issue | where | defect | fix |
|----|-------|-------|--------|-----|
| U1 | [#47](https://github.com/ccebelenski/anas/issues/47) | routes/iscsi-mutate.ts:834 + 75-iscsi.js:3408 | LUN delete confirm-gated only when `destroyBacking` set → one-click delete, checkbox unreachable | gate every LUN delete on `{target, lun}` (flag NOT in the code signature — the datasets.ts:1538 rule); warnings into the gate |
| K1 | [#48](https://github.com/ccebelenski/anas/issues/48) | 68-backup.js:6308, :7010 | restore dialogs pass `view: win` then close on 202 → poll dies; failed restores silent, grids stale | pass the long-lived grid as `view`; close from `onSubmitted` stays |
| K2 | [#49](https://github.com/ccebelenski/anas/issues/49) | 68-backup.js:7690 | new-LUN restore pickers loaded only on the LUN door → unusable from grid/details/repo doors | load backing choices wherever target choices load (once) |
| D1 | [#50](https://github.com/ccebelenski/anas/issues/50) | parsers/zfs-list.ts:46 → routes/datasets.ts:234 | volsize from rounded `zfs list` (no `-p`) feeds the never-shrink gate → rounding window allows a real shrink | `-p` + teach parseHumanSize bare integers (unit-less), or `zfs get -Hp` at the gate |

Wave-1 exit criterion: regression tests that would have caught each one. U1/K1/K2 were invisible
to the dialog harness because it stubs `ANAS.confirmAndRun` and asserts on recorded opts — add
route-level gate tests (a first DELETE with no query MUST 409) and a harness mode that exercises
the real 202/409 flow for the restore/delete doors. D1 gets a fixture with a rounded `zfs list`
value vs exact bytes.

## Wave 2 — data-safety MEDIUMs (daemon)

**Status: COMPLETE 2026-09-03** — #52 `42ec599`, #53+M1 `75a4a9d`, #51 `4ac5c46`, #54 `fa6863e`, D3+D4 `94663f7`. Open: M3 only (awaits its GT probe).

| id | issue | where | defect | fix |
|----|-------|-------|--------|-----|
| D2 | [#51](https://github.com/ccebelenski/anas/issues/51) | routes/ahr-snapshots.ts:198 | AHR rollback has no held-by-LUN pre-flight (ZFS twin has one); unmounted pool → `mv @data` under LIO's open fd, silent divergence | same `ahrPoolHeldByLun` refusal as ahr-mutate.ts, before the confirm gate |
| R1 | [#52](https://github.com/ccebelenski/anas/issues/52) | routes/backup.ts:1532/1683 + services/backup-restore.ts:508 | in-place image restore's session gate evaluated at request time only; queued job never re-checks | re-read sessions in-job under the iSCSI lock right before disable; fail with the live-sessions wording |
| M2 | [#53](https://github.com/ccebelenski/anas/issues/53) | routes/iscsi-mutate.ts:657/700/751 | `lun.size === null` treated as grow → shrink gate and session gate both fall through to a bare truncate | null size → 409 "cannot prove this is a grow" |
| C1 | [#54](https://github.com/ccebelenski/anas/issues/54) | services/iscsi-quarantine.ts:181 | quarantine ignores ownership → can tear down stubs on hands-off targets | skip `ownership !== 'anas'`; still report the card |
| M1 | — | routes/iscsi-mutate.ts:751 | `{size, writeBack}` on a zvol drops the writeBack while audit + warning claim it applied | run `setLunWriteBack` after the grow, or refuse the combination |
| D3 | — | services/iscsi-held.ts:118 | claims cache drops `installed`; failed read indistinguishable from "no LIO"; confirm doors can't disclose | keep `installed`/`readFailed`; append one warning line at destroy/export doors |
| D4 | — | routes/pools.ts | `handsOff: 'iscsi-served-here'` consumed by AHR only; ZFS create/add-vdev/attach never read the inventory (pre-existing absence, widened here) | resolve ids via collectDisks, refuse `!isComposableDisk` with the AHR message shape |
| M3 | — | services/iscsi-mutate.ts:656 | portal removal under live sessions has no gate (ACL removal is confirm-gated) | **GT ANSWERED (LIVE-PROOF-0.3.1 LP6):** the established session SURVIVES np delete (listener only; I/O continues, no kernel messages either side) but re-login/discovery through that address dies (error 8). **DONE 2026-09-04** (`6e9b11d`): confirm-with-warnings matching IscsiSession.connections[].address to the removed portal; combined ACL+portal edit folds into one challenge. |

## Wave 3 — UI correctness and staleness (MEDIUM)

**Status: COMPLETE 2026-09-03** — U2 spans `eddc555` (75-iscsi half) + the K3-K7/U2 commit; K3/K4/K5 in that same commit.

| id | where | defect | fix |
|----|-------|--------|-----|
| U2 | 75-iscsi.js:2080/2795 | LUNs-window backup coverage read once; task doors have no completion callback → stale "not backed up", invites duplicate task | `onDone` on openNewTask/openEditTask → re-read coverage |
| K3 | 68-backup.js:6983 | image submit uses the 15 s default poll budget → "finished" while running, grids reloaded early | `maxMs: 3600000` like the files half; `showNewLunResult` distinguishes still-running |
| K4 | 68-backup.js:6549/:7934 | `findRecord` without `exactMatch` = prefix match (wrong repo ns prefill; dataset vs ahrPool) | `findRecord(f, v, 0, false, true, true)` (in-repo form) |
| K5 | 68-backup.js:3037 | nested-scan responses race; stale path's boundary verdict can drive `includeNested` | request-generation stamp, drop stale resolutions |

## Wave 4 — LOW sweep (one story, grouped by area)

**Status: COMPLETE 2026-09-03** — iSCSI daemon `48ce526`; backup/executor `e181010`; UI `eddc555` + the K3-K7/U2 commit. Also fixed outside the plan: issue #46 `15e708f`.

- **iSCSI daemon:** M4 bare `/dev/zvol/<pool>` accepted as backing (ownership.ts:191 fallback) → refuse at route; M5 destroy warning promises snapshots ("-r") but command is a plain `zfs destroy` that fails AFTER unmap, before saveconfig → pre-check snapshots in the route + align text; C3 repair `size ?? 0` for a size-less fileio record → refuse the item; C4 post-quarantine missingLuns card says "restore the image" ANAS itself deleted → thread `fileRemoved` into the wording.
- **Backup daemon:** R2 newLocation write-test probes the immediate parent (client creates the chain) → probe nearest existing ancestor; R3 `.anas-restore-partial` never removed on a successful retry into the same dir; R4 image `rate` unvalidated (reuse `BackupRateLimit`); R5 wrong-password → "Datastore.Audit" wording (reuse backup-runner.ts:892's auth/privs split — single source of truth); B1 same-second restart hits "dataset already exists" → destroy-and-retake own label.
- **Executor:** D5 `ExecStreamResult` lacks `signal` (killed image restore reports a progress line as the reason); D6 `ExecStreamOptions` advertises `stdin` that execToStream ignores → honour or Omit<>; D7 `SECRET_ARG_RE` ^-anchor misses a joined token → word-boundary match; D8 mock stream fixtures first-registered-wins vs exec's exact-first.
- **UI:** U3 pool-root row drops `heldByLun` (share one field list); U4 "Back up…" menu rebuilt every 5 s poll; U5 `netCache` never invalidated (and caches failures); U6 picker load has no generation guard; U7 Serial column tooltip lacks the value (never-truncate rule); U8 `portalsChanged` set-compare swallows a duplicate-portal edit; K6 literal "undefined" LUN name from older daemons (`v == null`); K7 LUN-picker columns get `htmlEncode` renderers.

## Post-live-proof findings (2026-09-04 round, docs/LIVE-PROOF-0.3.1.md — all 7 items PASS)

- **F1 MEDIUM — RESOLVED (code):** a FOREIGN target's stub used to set `degraded: true` and 409
  every ANAS iSCSI mutation node-wide (`stub-backing`), while #54 correctly guarantees ANAS never
  clears it; the refusal text promised an offline-taking that never happens and Repair answered
  nothing-to-repair, so only hand-targetcli escaped. **Fix:** `degraded` (in `iscsi-health.ts` and
  the quarantine's post-tear-down recompute) now counts only ANAS-OWNED stubs plus missing LUNs, so
  a node whose only placeholder is on a hands-off target is saveable and `assertSaveable` returns
  null — mutations flow. The stub is still REPORTED as a health card and dashboard warning
  (unchanged). `IscsiStubLun` gained an `ownership` field to carry the verdict, and
  `assertSaveable`'s `stub-backing` refusal now filters to ANAS-owned stubs, keeping its "ANAS takes
  such a LUN offline …" promise honest (every LUN it names is one ANAS really does take offline).
  Tests fail on the old code.
- **O1 LOW — RESOLVED (code):** an unaligned volsize grow failed as a job with raw ZFS text out of a
  202 while the create door rounds silently. **Fix:** `growZvolLun` reads the volume's
  `volblocksize` (`zfs get -Hp`) and rounds the requested size UP to a multiple before `zfs set
  volsize=`, exactly as `zfs create -V` does — and returns the applied size so the job result and
  read model agree with the filesystem. Fail-open: an unreadable volblocksize applies the size as
  asked (the pre-fix behaviour). Tests fail on the old code.
- **O2 LOW — RESOLVED (code):** a file-kind LUN create accepted a configured-but-UNMOUNTED dataset
  backing (image written to the parent; quarantine caught it later). **Fix:** `resolveFileBackingDir`
  now checks `zfs get -Hp -o value mounted <dataset>` at the add-LUN door — for both the dataset-name
  and the absolute-path forms — and refuses (`backing-unmounted`) when the dataset is provably not
  mounted, naming the mountpoint the parent would swallow. Fail-open on an unreadable mount state
  (quarantine stays the net). Tests fail on the old code.
- **O3 LOW (boot):** an AHR fstab entry whose device never appears delays rtslib-fb-targetctl (and
  multi-user.target) ~90 s via the x-systemd.before ordering; nofail prevents failure, not the wait.

## Rulings needed (not code yet)

- **C2 — RULED + IMPLEMENTED (code):** `GET /iscsi/health` runs the quarantine (deliberate, story
  iscsi.8) outside the job model with no session check. **Ruling: a stub on an ANAS-OWNED target is
  torn down EVEN WHEN it has a live session.** A stub serves a 0-byte placeholder (zeros/garbage),
  so leaving it mapped serves CORRUPTION to whatever is reading it; unmapping it — which kicks that
  session — is the safer outcome. There is no ambiguity to protect against: the two-signal verdict
  (`zeroSized` / `wrongMount`) proves the file behind the LUN is not the data whether or not an
  initiator is attached, so a session is never evidence ANAS would be tearing down a live *data*
  disk. The quarantine already did this (it never checked sessions); the ruling is recorded as a
  comment where it decides to act (`iscsi-quarantine.ts`), and the health card / dashboard warning
  already say so honestly ("this LUN was serving an empty placeholder, not your data; ANAS took it
  offline"). Foreign skip is C1/#54 regardless. This also settles the F1 half: a foreign stub does
  NOT degrade the node — see F1 below.
- **New-LUN restore holds the iSCSI mutex across the whole image stream** (routes/backup.ts newLun job wrap —
  pre-existing, surfaced while fixing #52): every iSCSI mutation on the node queues behind an hours-long
  restore. **RESOLVED (code):** the whole-job `withIscsiLock` wrap is gone from the route;
  `runNewLunImageRestore` now OWNS the lock and takes it only for its short targetcli sections
  (create+map the LUN, the final `saveconfig`, and each cleanup undo), releasing it across the
  multi-hour `execToStream` and the size read-back — the exact shape #52 applied to the in-place door.
  The stream writes the new backing OBJECT, not the LIO tree, so it needs no mutual exclusion; the mutex
  is a plain chain (not reentrant), which is why ownership had to move into the service. Lock-structure
  tests in `backup-restore-elsewhere.test.ts` prove a concurrent mutation WAITS during create+map and
  during saveconfig, and RUNS during the stream (the two "under the lock" tests fail on the old
  whole-job-wrap code).
- **Crash-window record for new-LUN restore:** a daemon crash (not a job failure) mid-stream
  leaves a healthy-looking, unpersisted LUN holding half an image; the in-place path's record is
  the disabled target, the new-LUN path has no equivalent. **RESOLVED (a) — documentation only, NO
  new state.** Trace: `saveconfig` is the LAST step, so a crash mid-stream leaves the new LUN LIVE in
  configfs but absent from `saveconfig.json`. On a host REBOOT (the LIO persistence boundary) boot
  restores from `saveconfig.json`, which never held the LUN → it is simply GONE, leaving only an inert
  orphaned backing object on disk (served to no one). It is NOT a stub — a stub is a *persisted* LUN
  whose backing went missing (iscsi.5/iscsi.8), the opposite case — and the size-based stub detector
  cannot see it anyway: the backing is created at exactly the manifest size, so the size is correct and
  only the CONTENTS are half. On a daemon-only restart (host up) the LUN lingers live and correct-sized,
  but the pre-existing persisted⟷live health diff (`GET /iscsi/health`, iscsi.2) ALREADY names it:
  `lun-not-persisted` — "live but not in the saved configuration — it will not come back after a reboot".
  A completed restore saves the config (persisted); a crashed one does not, so that flag is the honest
  equivalent of the in-place path's disabled-target record, derived from live state with zero shadow
  state. This is just the general LIO live-then-save model (the ordinary add-LUN door has the same
  window, only milliseconds wide), so the stateless principle wins — no marker. A structural alternative
  that would close even the daemon-restart window (map the LUN only AFTER the stream completes, so a
  crash leaves only an inert orphaned backing) is recorded but NOT adopted: it trades away the current
  order's fail-fast property (prove LIO will accept the LUN before spending hours streaming) and is a
  larger redesign. The finding lives in a `runNewLunImageRestore` doc comment.
- **Pre-existing, explicitly out of 0.3.1 unless promoted:** B2 backupId has no cross-task
  uniqueness (two tasks can share a PBS group and prune each other); B3 BackupRepo doesn't tie
  authType to username/tokenId (empty auth-id repo string). Both predate 0.3.0.
- **GT probes to schedule with M3:** np-delete vs established session; `\?` glob escape is
  unproven by the pattern matrix (only `\*` `\[` `\]` probed).

## Verification bar

Every wave-1/2 fix lands with a test that fails on the old code; UI fixes verified through the
dialog harness where it can see them and by hand where it cannot; the full suite green before
0.3.1 is tagged. Release notes for 0.3.1 list the fixed issues by number.
