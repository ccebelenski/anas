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

| id | issue | where | defect | fix |
|----|-------|-------|--------|-----|
| D2 | [#51](https://github.com/ccebelenski/anas/issues/51) | routes/ahr-snapshots.ts:198 | AHR rollback has no held-by-LUN pre-flight (ZFS twin has one); unmounted pool → `mv @data` under LIO's open fd, silent divergence | same `ahrPoolHeldByLun` refusal as ahr-mutate.ts, before the confirm gate |
| R1 | [#52](https://github.com/ccebelenski/anas/issues/52) | routes/backup.ts:1532/1683 + services/backup-restore.ts:508 | in-place image restore's session gate evaluated at request time only; queued job never re-checks | re-read sessions in-job under the iSCSI lock right before disable; fail with the live-sessions wording |
| M2 | [#53](https://github.com/ccebelenski/anas/issues/53) | routes/iscsi-mutate.ts:657/700/751 | `lun.size === null` treated as grow → shrink gate and session gate both fall through to a bare truncate | null size → 409 "cannot prove this is a grow" |
| C1 | [#54](https://github.com/ccebelenski/anas/issues/54) | services/iscsi-quarantine.ts:181 | quarantine ignores ownership → can tear down stubs on hands-off targets | skip `ownership !== 'anas'`; still report the card |
| M1 | — | routes/iscsi-mutate.ts:751 | `{size, writeBack}` on a zvol drops the writeBack while audit + warning claim it applied | run `setLunWriteBack` after the grow, or refuse the combination |
| D3 | — | services/iscsi-held.ts:118 | claims cache drops `installed`; failed read indistinguishable from "no LIO"; confirm doors can't disclose | keep `installed`/`readFailed`; append one warning line at destroy/export doors |
| D4 | — | routes/pools.ts | `handsOff: 'iscsi-served-here'` consumed by AHR only; ZFS create/add-vdev/attach never read the inventory (pre-existing absence, widened here) | resolve ids via collectDisks, refuse `!isComposableDisk` with the AHR message shape |
| M3 | — | services/iscsi-mutate.ts:656 | portal removal under live sessions has no gate (ACL removal is confirm-gated) | FIRST: ground-truth what LIO does to an established session on np delete (GT-37 covers new logins only); then refuse/confirm/warn accordingly |

## Wave 3 — UI correctness and staleness (MEDIUM)

| id | where | defect | fix |
|----|-------|--------|-----|
| U2 | 75-iscsi.js:2080/2795 | LUNs-window backup coverage read once; task doors have no completion callback → stale "not backed up", invites duplicate task | `onDone` on openNewTask/openEditTask → re-read coverage |
| K3 | 68-backup.js:6983 | image submit uses the 15 s default poll budget → "finished" while running, grids reloaded early | `maxMs: 3600000` like the files half; `showNewLunResult` distinguishes still-running |
| K4 | 68-backup.js:6549/:7934 | `findRecord` without `exactMatch` = prefix match (wrong repo ns prefill; dataset vs ahrPool) | `findRecord(f, v, 0, false, true, true)` (in-repo form) |
| K5 | 68-backup.js:3037 | nested-scan responses race; stale path's boundary verdict can drive `includeNested` | request-generation stamp, drop stale resolutions |

## Wave 4 — LOW sweep (one story, grouped by area)

- **iSCSI daemon:** M4 bare `/dev/zvol/<pool>` accepted as backing (ownership.ts:191 fallback) → refuse at route; M5 destroy warning promises snapshots ("-r") but command is a plain `zfs destroy` that fails AFTER unmap, before saveconfig → pre-check snapshots in the route + align text; C3 repair `size ?? 0` for a size-less fileio record → refuse the item; C4 post-quarantine missingLuns card says "restore the image" ANAS itself deleted → thread `fileRemoved` into the wording.
- **Backup daemon:** R2 newLocation write-test probes the immediate parent (client creates the chain) → probe nearest existing ancestor; R3 `.anas-restore-partial` never removed on a successful retry into the same dir; R4 image `rate` unvalidated (reuse `BackupRateLimit`); R5 wrong-password → "Datastore.Audit" wording (reuse backup-runner.ts:892's auth/privs split — single source of truth); B1 same-second restart hits "dataset already exists" → destroy-and-retake own label.
- **Executor:** D5 `ExecStreamResult` lacks `signal` (killed image restore reports a progress line as the reason); D6 `ExecStreamOptions` advertises `stdin` that execToStream ignores → honour or Omit<>; D7 `SECRET_ARG_RE` ^-anchor misses a joined token → word-boundary match; D8 mock stream fixtures first-registered-wins vs exec's exact-first.
- **UI:** U3 pool-root row drops `heldByLun` (share one field list); U4 "Back up…" menu rebuilt every 5 s poll; U5 `netCache` never invalidated (and caches failures); U6 picker load has no generation guard; U7 Serial column tooltip lacks the value (never-truncate rule); U8 `portalsChanged` set-compare swallows a duplicate-portal edit; K6 literal "undefined" LUN name from older daemons (`v == null`); K7 LUN-picker columns get `htmlEncode` renderers.

## Rulings needed (not code yet)

- **C2:** `GET /iscsi/health` runs the quarantine (deliberate, story iscsi.8) outside the job
  model with no session check. Decide and write down: does a stub with a LIVE session still get
  yanked (serving zeros vs kicking the initiator)? Foreign skip is C1/#54 regardless.
- **New-LUN restore holds the iSCSI mutex across the whole image stream** (routes/backup.ts newLun job wrap —
  pre-existing, surfaced while fixing #52): every iSCSI mutation on the node queues behind an hours-long
  restore. Same fix shape as #52 (lock only the targetcli sections). Promote to a wave when convenient.
- **Crash-window record for new-LUN restore:** a daemon crash (not a job failure) mid-stream
  leaves a healthy-looking, unpersisted LUN holding half an image; the in-place path's record is
  the disabled target, the new-LUN path has no equivalent. Decide whether a marker is wanted.
- **Pre-existing, explicitly out of 0.3.1 unless promoted:** B2 backupId has no cross-task
  uniqueness (two tasks can share a PBS group and prune each other); B3 BackupRepo doesn't tie
  authType to username/tokenId (empty auth-id repo string). Both predate 0.3.0.
- **GT probes to schedule with M3:** np-delete vs established session; `\?` glob escape is
  unproven by the pattern matrix (only `\*` `\[` `\]` probed).

## Verification bar

Every wave-1/2 fix lands with a test that fails on the old code; UI fixes verified through the
dialog harness where it can see them and by hand where it cannot; the full suite green before
0.3.1 is tagged. Release notes for 0.3.1 list the fixed issues by number.
