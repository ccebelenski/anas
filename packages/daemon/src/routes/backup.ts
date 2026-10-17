import type {
  BackupBrowseResult,
  BackupFilesRestoreRequest,
  BackupGroupList,
  BackupImageRestoreRequest,
  BackupLunSource,
  BackupLunSourceList,
  BackupNestedPreviewResponse,
  BackupNestedScan,
  BackupPrunePreviewResponse,
  BackupRepo,
  BackupRepoResponse,
  BackupRepoTestResult,
  BackupSnapshotList,
  BackupTask,
  BackupTaskDetail,
  BackupTaskEntry,
  BackupTaskView,
  IscsiTargetDetail,
} from '@anas/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { LockClaim } from '../jobs/locks.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { Gate, GuardPass, GuardSpec, ObjectView, Refusal } from '../safety/guard.js'
import type { ConsistencyFacts } from '../services/backup-consistency.js'
import type { BackupReposPaths } from '../services/backup-repos.js'
import type { SelectionFacts } from '../services/backup-restore-files.js'
import type { TargetObject } from '../services/iscsi-guard.js'
import type { BackingRefusal, ResolvedAhrPool, ResolvedBacking } from '../services/iscsi-mutate.js'
import type { IscsiPaths, IscsiReadContext } from '../services/iscsi.js'
import type { SourceClaims } from '../services/source-claims.js'
import type { UnitTaskObject } from '../services/task-units.js'
import { createHash } from 'node:crypto'
import {
  BACKUP_SKIPPED_OFF_WEEK,
  BackupBrowseRequest,
  BackupName,
  BackupNestedPreviewRequest,
  BackupPrunePreviewRequest,
  BackupRepoRef,
  BackupRepoTestRequest,
  BackupRestoreRequest,
  BackupRunRequest,
  BackupTaskRequest,
  classifyArchiveFile,
  composeGroupId,
  effectiveArchiveKind,
  effectiveIncludeNested,
  effectiveTaskKind,
  groupOfSnapshotId,
  hasRetentionKeeps,
  lunBackupId,
  UpsertBackupRepoRequest,
} from '@anas/shared'
import { assertRunNotCancelled, ChildCancel } from '../jobs/child-cancel.js'
import { JobCancelledError, JobFailedDespiteCancelError } from '../jobs/queue.js'
import { READ_JOB_OPERATIONS, readJobCancel } from '../jobs/read-jobs.js'
import { readPbsStorages } from '../parsers/pve-storage.js'
import { directFromClientRefusal, TASK_RUNNER_USER } from '../runner-poll.js'
import { guardCheck, guardConfirm, guarded, GuardReads, GuardRefusalError, iscsiTargetClaim, reverify, sendRefusal, sourcePathsMoved, taskClaim, unheldClaimsRefusal, zfsDatasetClaims } from '../safety/guard.js'
import { readPoolGuid } from '../safety/stable-id.js'
import { readAhrPools } from '../services/ahr-topology.js'
import { browseArchiveLevel } from '../services/backup-catalog.js'
import { deriveConsistency, readConsistencyFacts } from '../services/backup-consistency.js'
import { notifyBackupRun } from '../services/backup-notify.js'
import { defaultBackupId, groupKeyUnchanged, pruneAfterBackup, pruneGroup, runPrune, sharedGroupMessage, taskSharingGroup } from '../services/backup-prune.js'
import { listGroups, listSnapshots } from '../services/backup-reads.js'
import {
  backupNodename,
  isPveRepoName,
  pbsDefToRepo,
  pveRepoName,
  pveSecretSet,
  pveStorageId,
  readBackupRepos,
  readPveSecret,
  readRepoSecret,
  removeRepoSecret,
  repoSecretSet,
  writeBackupRepos,
  writeRepoSecret,
} from '../services/backup-repos.js'
import {
  availableBytes,
  bareArchiveName,
  estimateSpace,
  parentDirectory,
  pathKind,
  readPveMountPathsStrict,
  readSelectionFacts,
  restoreTerritoryRefusal,
  runFileRestore,
  writeTestDirectory,
} from '../services/backup-restore-files.js'
import {
  assertSizeMatch,
  imageArchiveSize,
  liveSessionsRefusal,
  readTargetSize,
  runImageRestore,
  runNewLunImageRestore,
  snapshotGroup,
} from '../services/backup-restore.js'
import {
  buildBackupEnv,
  buildProbeArgs,
  classifyTestVerdict,
  effectiveNamespace,
  fetchServerFingerprint,
  normalizeFingerprint,
  PBC,
  resolvesDns,
  runBackup,
  tcpReachable,
} from '../services/backup-runner.js'
import {
  BACKUP_UNIT_KIND,
  clearCancelledRunFailedState,
  deriveTaskStatus,
  DISABLED_HISTORY_NOTE,
  effectiveSchedule,
  gateRun,
  readAllTasks,
  readRecentJournal,
  readRunActive,
  readTask,
  readUnitTexts,
  removeTaskUnits,
  runningDirectJobFields,
  runningDirectJobProgress,
  runningRunConflictMessage,
  serviceUnitName,
  superviseRun,
  taskFileExists,
  validateSchedule,
  writeTaskUnits,
} from '../services/backup-units.js'
import { CONFIGFS_TARGET_ROOT } from '../services/iscsi-configfs.js'
import { conflict, foreignGate, lunClaims, lunNameFreeGate, saveableGate, targetView } from '../services/iscsi-guard.js'
import { createIscsiClaimCache, heldByLun, heldByLunRefusal } from '../services/iscsi-held.js'
import {
  assertInstalled,
  assertSaveable,
  imageFilePath,
  lunBackingClaims,
  readIscsiState,
  resolveFileBackingDir,
  resolveZvolBacking,
} from '../services/iscsi-mutate.js'
import { classifyBacking } from '../services/iscsi-ownership.js'
import { checkServedDevice, reverifyServedLun, servedLunIdentity, statDeviceFrom } from '../services/iscsi-served.js'
import { buildIscsiTargets, iscsiAvailability, readIscsiContext } from '../services/iscsi.js'
import { normalizeMountpointPath } from '../services/mounts.js'
import { imageArchiveScan, NESTED_SCAN_PREVIEW_TIMEOUT_S, scanArchives, scanNestedFilesystems } from '../services/nested-filesystems.js'
import { pathSourceClaims, unlockedSourcesLine } from '../services/source-claims.js'
import { readSourceGuardFacts, unmountedMountFor } from '../services/source-guard.js'
import { activeRunDeleteRefusal, readUnitStoreEntry, readUnitTaskObject, runStateUnreadableRefusal, serviceUnitRevision, taskRunInFlight } from '../services/task-units.js'
import { requireIdentity } from './identity.js'

/**
 * PBS file backup routes (Epic 16) — the repositories registry (CAS corosync
 * store + per-repo secrets + diagnosing test) and the task store (systemd
 * units-as-store CRUD + LOCAL-ONLY status + Run-Now with progress).
 *
 *   GET    /v1/backup/repos            → { version, repos[+credentialsSet] }
 *   POST   /v1/backup/repos            → register (CAS; 409 on stale/dup)
 *   PUT    /v1/backup/repos/:name      → update / rotate credentials (CAS)
 *   DELETE /v1/backup/repos/:name      → unregister (CAS; 409 while a task uses it)
 *   POST   /v1/backup/repos/test       → dns/tcp/tls/auth/datastore/namespace
 *   GET    /v1/backup/tasks            → task grid (systemd state)
 *   GET    /v1/backup/tasks/:name      → detail (config + units + journald)
 *   POST   /v1/backup/tasks            → create (write units, enable timer)
 *   PUT    /v1/backup/tasks/:name      → update / enable / disable
 *   DELETE /v1/backup/tasks/:name      → remove units (PBS data untouched)
 *   POST   /v1/backup/tasks/:name/run  → Run Now (UI: start+supervise the unit;
 *                                        direct:true: the unit's own pbc exec)
 *   POST   /v1/backup/tasks/:name/prune-preview → retention dry-run (16.11)
 *   POST   /v1/backup/tasks/preview-nested → nested-filesystem scan (backup2.2;
 *                                        LOCAL-ONLY: no PBS contact at all)
 *   GET    /v1/backup/lun-sources     → backup-eligible iSCSI LUNs, with their
 *                                        derived consistency (backup2.4; the
 *                                        `img` archive's picker, LOCAL-ONLY)
 *   GET    /v1/backup/tasks/:name/snapshots → the task group's points in time
 *   GET    /v1/backup/repos/:name/groups → groups (and, with ?group=, their
 *                                        snapshots) — the task-less door
 *   POST   /v1/backup/restore          → the ONE restore door: `kind: files`
 *                                        (backup2.6, selective) and
 *                                        `kind: image` (backup2.7, whole)
 *   POST   /v1/backup/restore/browse   → one directory level of an archive,
 *                                        via catalog shell over a pipe (backup2.5)
 *   POST   /v1/backup/restore         → whole-image LUN restore (backup2.7);
 *                                        `kind: files` is backup2.6's and 400s
 *
 * Mutations are identity-gated jobs (202 → { job }); registry writes are
 * COMPARE-AND-SWAP. Status is LOCAL-ONLY — ANAS never contacts the PBS server
 * except for backup runs, the explicit user-initiated Test, the post-backup
 * retention prune, and this story's user-initiated prune preview. Never polls.
 */
export interface BackupRouteOptions {
  executor: CommandExecutor
  jobQueue: JobQueue
  /**
   * backup2.7 — the whole-image LUN restore's 409 + X-Anas-Confirm-Code gate.
   * Optional so an older wiring (and the pre-backup2.7 route tests) still
   * registers; a restore without it refuses rather than skipping the gate.
   */
  confirmStore?: ConfirmStore
  /** Registry + creds paths (pmxcfs registry / 0600 secret files). */
  paths: BackupReposPaths
  /** systemd unit directory (the task store). Overridable for tests. */
  systemdDir: string
  /**
   * backup2.4 — the iSCSI read layer's paths, for the LUN-source picker. All
   * overridable for tests; absent means the real configfs / saveconfig /
   * storage.cfg locations, and a node with no LIO stack answers
   * `installed: false` with an empty list.
   */
  iscsiPaths?: IscsiPaths
  /**
   * backup2.10 — the fstab a file-backed new LUN on an AHR pool gets its boot
   * ordering from (story iscsi.8), same option the add-LUN route takes.
   */
  fstabPath?: string
}

/**
 * The in-place image restore's CONFIRM-ONLY spec (cr.56). Its confirm goes
 * through `guardConfirm` so a resend with a changed request field answers 409
 * CONFIRM_SCOPE_CHANGED naming it, but the door is not on a guard spec — its
 * job-time re-checks are `runImageRestore`'s own, under the iSCSI lock — so
 * this names only the operation and how a message calls the LUN. Nothing
 * here is read, gated or locked: `guardCheck` and `guarded` never see it.
 */
function imageRestoreConfirmSpec(what: string): GuardSpec<null> {
  return {
    operation: 'backup.restore.image',
    object: { what, read: async () => null, id: async () => null, unbound: () => `${what} could not be bound` },
    gates: [],
  }
}

/** The pass a confirm-only spec signs with: no id, revision or scope — the signed request fields carry the binding. */
const CONFIRM_ONLY_PASS: GuardPass<null> = { object: null, bound: { id: {} }, advisories: [], locks: [] }

/**
 * What cancelling a backup run leaves behind — the confirm dialog's
 * consequence sentence, verbatim from the rclone.5 story (backup parity).
 */
export const BACKUP_CANCEL_CONSEQUENCE
  = 'The unfinished snapshot is discarded by the backup server; earlier snapshots are untouched.'

function CONFLICT(version: number) {
  return {
    error: { code: 'CONFLICT', message: `backup repositories registry changed (version ${version}) — reload and retry` },
  }
}

export async function backupRoutes(server: FastifyInstance, opts: BackupRouteOptions) {
  const { executor, jobQueue, paths, systemdDir, confirmStore, fstabPath = '/etc/fstab' } = opts
  const iscsiPaths: IscsiPaths = opts.iscsiPaths ?? {}

  /**
   * Attach the DERIVED snapshot-consistency (backup2.3) to a set of boundary
   * scans. It rides the SCAN rather than a second endpoint because both answers
   * come from the same facts — the mount table the scan already needed, plus the
   * AHR topology — and because the wizard asks the two questions at exactly the
   * same moment (a row's path changed).
   *
   * READ-ONLY and additive: no request body carries `consistency` back, and
   * nothing can set it. FAIL-OPEN — a derivation that throws leaves the key
   * absent ("not known"), never a fabricated `live`.
   */
  async function withConsistency(scans: BackupNestedScan[]): Promise<BackupNestedScan[]> {
    try {
      const facts = await readConsistencyFacts(executor, readAhrPools, { pveStorageCfg: paths.pveStorageCfg })
      // backup2.11 — the save-time WARNING half of the source guard. The same
      // fstab + mount table, read ONCE for the whole request, and the run's own
      // guard reads them again at run start: this answer is time-dependent (a
      // task may legitimately be defined during an outage) so it informs, and
      // the run is what refuses. Fail-open comes from the helper itself.
      const guard = await readSourceGuardFacts(executor, fstabPath)
      return scans.map((scan) => {
        // A "ZFS facts could not be read" verdict is a transient read failure,
        // not a fact about this path: the save-time warning stays silent on it
        // and the run (which reads the facts again) is the gate.
        const verdict = unmountedMountFor(scan.path, guard)
        const unmounted = verdict?.zfsFactsUnavailable ? null : verdict
        return {
          ...scan,
          consistency: deriveConsistency(scan.path, facts),
          ...(unmounted ? { unmounted } : {}),
        }
      })
    }
    catch (err) {
      server.log.warn(`[backup] consistency derivation failed: ${err instanceof Error ? err.message : String(err)}`)
      return scans
    }
  }

  // ==========================================================================
  //  Repositories
  // ==========================================================================

  /** A tier-2 (ANAS-registered) repo response (adds `credentialsSet`, source). */
  async function toRepoResponse(repo: BackupRepo): Promise<BackupRepoResponse> {
    return { ...repo, credentialsSet: await repoSecretSet(paths.credsDir, repo.name), source: 'anas' }
  }

  /**
   * The tier-1 (PVE-defined) repositories: every `pbs` stanza in storage.cfg,
   * mapped to the repo response shape as `pve:<id>` with `source: 'pve'` and
   * `credentialsSet` reflecting whether the `.pw` file exists. Read-only; the
   * secret itself is NEVER read here (only at exec/test time). FAIL-OPEN.
   */
  async function pveRepoResponses(): Promise<BackupRepoResponse[]> {
    const defs = await readPbsStorages(paths.pveStorageCfg)
    return Promise.all(defs.map(async (def): Promise<BackupRepoResponse> => ({
      ...pbsDefToRepo(def),
      credentialsSet: await pveSecretSet(paths.pvePrivStorageDir, def.id),
      source: 'pve',
    })))
  }

  /**
   * Resolve a repo REFERENCE (tier-2 name or `pve:<id>`) to its runtime repo +
   * secret, reading the secret FRESH at call time. Returns null when the repo
   * does not exist. A tier-1 secret comes from /etc/pve/priv/storage/<id>.pw;
   * a tier-2 secret from /etc/anas/creds — neither is cached.
   */
  async function resolveRepoAndSecret(
    name: string,
  ): Promise<{ repo: BackupRepo, secret: string | null } | null> {
    if (isPveRepoName(name)) {
      const id = pveStorageId(name)
      const def = (await readPbsStorages(paths.pveStorageCfg)).find(d => d.id === id)
      if (!def)
        return null
      return { repo: pbsDefToRepo(def), secret: await readPveSecret(paths.pvePrivStorageDir, id) }
    }
    const found = (await readBackupRepos(paths)).repos.find(r => r.name === name)
    if (!found)
      return null
    return { repo: found, secret: await readRepoSecret(paths.credsDir, name) }
  }

  /**
   * The merged repo list used only to JOIN a task's datastore for the view
   * (tier-2 registry + tier-1 PVE storages). The runner resolves its own repo +
   * secret separately (resolveRepoAndSecret).
   */
  async function reposForJoin(registered: BackupRepo[]): Promise<BackupRepo[]> {
    const defs = await readPbsStorages(paths.pveStorageCfg)
    return [...registered, ...defs.map(pbsDefToRepo)]
  }

  /** 400 body for a mutation attempted on a hands-off PVE-defined repository. */
  function pveHandsOff(name: string) {
    return {
      error: {
        code: 'PVE_MANAGED',
        message: `Repository '${name}' is defined by Proxmox in storage.cfg — manage it in `
          + 'Datacenter → Storage. ANAS never writes storage.cfg or the credential file.',
      },
    }
  }

  // --- GET /backup/repos ----------------------------------------------------
  server.get('/backup/repos', async () => {
    const reg = await readBackupRepos(paths)
    const [registered, pve] = await Promise.all([
      Promise.all(reg.repos.map(toRepoResponse)),
      pveRepoResponses(),
    ])
    return { data: { version: reg.version, repos: [...registered, ...pve] } }
  })

  // --- POST /backup/repos — register (CAS) ----------------------------------
  server.post('/backup/repos', async (request, reply) => {
    const parsed = UpsertBackupRepoRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid repository request: ${parsed.error.issues[0]?.message}` } }
    }
    const { repo, expectedVersion } = parsed.data
    const authValidation = validateRepoAuth(repo)
    if (authValidation) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: authValidation } }
    }
    // A brand-new repo has no stored secret, so one must be supplied on create.
    if (!repo.secret) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: repo.authType === 'token' ? 'A token secret is required' : 'A password is required' } }
    }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const current = await readBackupRepos(paths)
    if (current.version !== expectedVersion) {
      reply.code(409)
      return CONFLICT(current.version)
    }
    if (current.repos.some(r => r.name === repo.name)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Repository '${repo.name}' already exists` } }
    }

    const { secret, ...stored } = repo
    const job = jobQueue.submit(
      'backup.repo.create',
      { ...identity, params: { repo: repo.name } },
      async () => {
        // cr.41 (§8.4): the secret is written AFTER the CAS — a lost CAS (a
        // version moved by another node in the window) must not leave a rotated
        // secret file for a repo the registry does not carry.
        const written = await writeBackupRepos(paths, expectedVersion, [...current.repos, stored])
        await writeRepoSecret(paths.credsDir, repo.name, secret)
        return { created: repo.name, version: written.version }
      },
    )
    reply.code(202)
    return { job }
  })

  // --- PUT /backup/repos/:name — update / rotate (CAS) ----------------------
  server.put<{ Params: { name: string } }>('/backup/repos/:name', async (request, reply) => {
    // Tier-1 PVE repos are hands-off — reject BEFORE the BackupName parse (a
    // `pve:<id>` name would otherwise fail with a cryptic validation error).
    if (isPveRepoName(request.params.name)) {
      reply.code(400)
      return pveHandsOff(request.params.name)
    }
    const nameParsed = BackupName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid repository name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const parsed = UpsertBackupRepoRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid repository request: ${parsed.error.issues[0]?.message}` } }
    }
    const { repo, expectedVersion } = parsed.data
    if (repo.name !== name) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Repository name in body ('${repo.name}') does not match URL ('${name}')` } }
    }
    const authValidation = validateRepoAuth(repo)
    if (authValidation) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: authValidation } }
    }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const current = await readBackupRepos(paths)
    if (current.version !== expectedVersion) {
      reply.code(409)
      return CONFLICT(current.version)
    }
    const existing = current.repos.find(r => r.name === name)

    // Advisory (NOT a block): changing a repo's auth style while tasks reference
    // it can strand them on the server's group-owner coupling (a group created
    // under password auth refuses a token writer, and vice-versa). Surface it.
    let advisory: string | undefined
    if (existing && existing.authType !== repo.authType) {
      const referencing = (await readAllTasks(systemdDir)).filter(t => t.repository === name)
      if (referencing.length) {
        advisory = `Auth style changed to '${repo.authType}'. Tasks (${referencing.map(t => t.name).join(', ')}) `
          + 'write existing PBS groups owned by the previous auth-id; PBS will refuse the new auth-id until a '
          + 'server-side change-owner is run (or the tasks use a fresh backup-id).'
      }
    }

    const { secret, ...stored } = repo
    const next = existing
      ? current.repos.map(r => (r.name === name ? stored : r))
      : [...current.repos, stored]

    const job = jobQueue.submit(
      'backup.repo.update',
      { ...identity, params: { repo: name } },
      async () => {
        // A blank secret keeps the stored one (write-only field — never cleared
        // by an edit that omits it), and (cr.41) the CAS comes FIRST: a lost CAS
        // must not rotate a secret onto a registry that did not move.
        const written = await writeBackupRepos(paths, expectedVersion, next)
        if (secret)
          await writeRepoSecret(paths.credsDir, name, secret)
        return { updated: name, version: written.version, ...(advisory ? { warnings: [advisory] } : {}) }
      },
    )
    reply.code(202)
    return { job }
  })

  // --- DELETE /backup/repos/:name?expectedVersion=N — unregister (CAS) -------
  server.delete<{ Params: { name: string }, Querystring: { expectedVersion?: string } }>(
    '/backup/repos/:name',
    async (request, reply) => {
      // Tier-1 PVE repos cannot be unregistered — they live in storage.cfg.
      if (isPveRepoName(request.params.name)) {
        reply.code(400)
        return pveHandsOff(request.params.name)
      }
      const nameParsed = BackupName.safeParse(request.params.name)
      if (!nameParsed.success) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Invalid repository name: ${nameParsed.error.issues[0]?.message}` } }
      }
      const name = nameParsed.data

      const rawVersion = request.query.expectedVersion
      const expectedVersion = rawVersion === undefined ? Number.NaN : Number(rawVersion)
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: 'DELETE requires a non-negative integer ?expectedVersion=N (the registry version you read)' } }
      }

      const identity = requireIdentity(request, reply)
      if (!identity)
        return

      const current = await readBackupRepos(paths)
      if (current.version !== expectedVersion) {
        reply.code(409)
        return CONFLICT(current.version)
      }
      if (!current.repos.some(r => r.name === name)) {
        reply.code(404)
        return { error: { code: 'NOT_FOUND', message: `Repository '${name}' not found` } }
      }

      // Refuse (409) while a backup TASK still references this repository.
      // Distinct code from the CAS 'CONFLICT': the UI reload-and-retries CAS
      // conflicts, but a referenced-repo refusal must show its message.
      const referencing = (await readAllTasks(systemdDir)).filter(t => t.repository === name)
      if (referencing.length) {
        reply.code(409)
        return {
          error: {
            code: 'IN_USE',
            message: `Repository '${name}' is still used by backup task(s): ${referencing.map(t => t.name).join(', ')} — remove them first`,
          },
        }
      }

      const job = jobQueue.submit(
        'backup.repo.remove',
        { ...identity, params: { repo: name } },
        async () => {
          // cr.41: the IN_USE refusal is re-run in the job — a task created
          // after the route's check must not be stranded on a removed repo.
          const referencing = (await readAllTasks(systemdDir)).filter(t => t.repository === name)
          if (referencing.length) {
            throw new GuardRefusalError({
              status: 409,
              code: 'IN_USE',
              message: `Repository '${name}' is still used by backup task(s): ${referencing.map(t => t.name).join(', ')} — remove them first`,
            })
          }
          const written = await writeBackupRepos(paths, expectedVersion, current.repos.filter(r => r.name !== name))
          await removeRepoSecret(paths.credsDir, name)
          return { removed: name, version: written.version }
        },
      )
      reply.code(202)
      return { job }
    },
  )

  // --- POST /backup/repos/test — staged diagnosis ---------------------------
  server.post('/backup/repos/test', async (request, reply) => {
    const parsed = BackupRepoTestRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid test request: ${parsed.error.issues[0]?.message}` } }
    }
    const req = parsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Resolve to a repo-like target + secret: a registered repo OR a tier-1
    // PVE-defined repo (both by name, secret loaded fresh) OR an inline config
    // (from the dialog, with its secret — or, when the secret was left blank on
    // an edit, the stored one; see the fallback in the inline branch).
    let repo: BackupRepo
    let secret: string | null
    if (!req.host && req.name) {
      const resolved = await resolveRepoAndSecret(req.name)
      if (!resolved) {
        reply.code(404)
        return { error: { code: 'NOT_FOUND', message: `Repository '${req.name}' not found` } }
      }
      // A `namespace` OVERRIDE lets the task wizard verify the TASK's effective
      // namespace (the task's, else the repo's) against a REGISTERED repo without
      // re-entering the whole config — the same `{ name }` form plus one field. A
      // blank override falls through to the repo's own namespace.
      repo = req.namespace
        ? { ...resolved.repo, namespace: req.namespace }
        : resolved.repo
      secret = resolved.secret
    }
    else {
      if (!req.host || !req.datastore || !req.authType) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: 'host, datastore and authType are required to test an unregistered repository' } }
      }
      repo = {
        name: req.name ?? '(inline)',
        host: req.host,
        port: req.port ?? 8007,
        datastore: req.datastore,
        authType: req.authType,
        ...(req.namespace ? { namespace: req.namespace } : {}),
        ...(req.tokenId ? { tokenId: req.tokenId } : {}),
        ...(req.username ? { username: req.username } : {}),
        ...(req.fingerprint ? { fingerprint: normalizeFingerprint(req.fingerprint) } : {}),
      }
      // The secret is WRITE-ONLY: it is never read back, so the edit dialog
      // sends none when the operator left the field blank — its '(unchanged)'
      // promise, and exactly what the save path then honours. Test has to make
      // the same promise, or it fails auth on a repo that saves and runs fine.
      // The fallback is keyed on the NAME while the rest of the config comes
      // from the request, so a repo whose host/datastore/token-id were edited is
      // tested as it would actually be SAVED: the new fields, the stored secret.
      secret = req.secret ?? null
      if (!secret && req.name) {
        const resolved = await resolveRepoAndSecret(req.name)
        secret = resolved?.secret ?? null
      }
    }

    const result = await diagnose(repo, secret)
    // Fire-and-forget audit record (journald) — never logs the secret.
    jobQueue.submit(
      'backup.repo.test',
      { ...identity, params: { repo: repo.name, host: repo.host, port: repo.port } },
      async () => ({ stage: result.stage }),
    )
    return { data: result }
  })

  /**
   * Probe a repo in stages, reporting WHAT failed. The daemon does its OWN dns +
   * tcp + tls-fingerprint checks (pbc collapses dns/tcp/route into one message),
   * then — only once a matching cert is pinned — falls to a cheap `snapshot list`
   * for auth/datastore/namespace.
   */
  async function diagnose(repo: BackupRepo, secret: string | null): Promise<BackupRepoTestResult> {
    if (!(await resolvesDns(repo.host)))
      return { stage: 'dns', detail: `Could not resolve host '${repo.host}'` }
    if (!(await tcpReachable(repo.host, repo.port)))
      return { stage: 'tcp', detail: `No answer on ${repo.host}:${repo.port}` }

    const serverFp = await fetchServerFingerprint(repo.host, repo.port)
    if (!serverFp)
      return { stage: 'tls-fingerprint', detail: 'TLS handshake failed — the server did not present a usable certificate.' }
    if (!repo.fingerprint) {
      return { stage: 'tls-fingerprint', fingerprint: serverFp, detail: 'Certificate is not yet pinned — confirm this fingerprint.' }
    }
    if (normalizeFingerprint(repo.fingerprint) !== serverFp) {
      return { stage: 'tls-fingerprint', fingerprint: serverFp, detail: 'Certificate fingerprint does not match the pinned value — confirm the new one to proceed.' }
    }

    // Cert confirmed. Now exercise auth/datastore/namespace via a cheap read.
    const env = buildBackupEnv(repo, secret ?? '')
    const r = await executor.exec(PBC, buildProbeArgs(repo.namespace), { env })
    // cr.48e: the verdict's detail leaves in the reply, so it is masked against
    // the secret THIS probe handed pbc (the value list is what the tool got).
    return classifyTestVerdict(r.exitCode, r.stderr, [secret ?? ''])
  }

  // ==========================================================================
  //  Tasks
  // ==========================================================================

  /**
   * The one journald line a cancelled run leaves instead of a notification
   * (rclone.5, backup parity). The queue ends the job `cancelled` whatever the
   * body returns once the cancel was accepted — the value is a placeholder.
   *
   * This is also the one place that knows both the task's unit name and that
   * the run ended cancelled, so it settles systemd's failed state here
   * (0.4.1, backup parity): the runner exits 130 at its next poll, the unit
   * does not declare that a success, and without a `reset-failed` the unit
   * sits in `systemctl --failed` until the task's next run. DETACHED on
   * purpose: the unit cannot go terminal until THIS body returns — the runner
   * learns of the cancel by polling the job — so awaiting it would hold the
   * job for the whole settle ceiling.
   */
  function logCancelledRun(name: string): null {
    server.log.info(`backup task '${name}' cancelled — no notification sent`)
    void clearCancelledRunFailedState(executor, name)
      .then((reset) => {
        if (reset)
          server.log.info(`backup task '${name}': ${serviceUnitName(name)} left systemd's failed list after its cancelled run`)
      })
      .catch(() => undefined)
    return null
  }

  /** The datastore for a task's repository (joined so the UI need not). */
  function datastoreOf(task: BackupTask, repos: BackupRepo[]): string | undefined {
    return repos.find(r => r.name === task.repository)?.datastore
  }

  /**
   * A task enriched for the response: its repo's datastore, and — backup2.9 —
   * the legacy-shape flag. The `kind` key stays the STORED value (absent on a
   * unit that predates the field): the effective answer is a DERIVATION the
   * client performs through the shared effectiveTaskKind — which is what lets
   * the edit dialog tell a stored `block` (send it back) from a derived one
   * (send nothing, keep the pre-backup2.9 id and group).
   */
  function toTaskView(task: BackupTask, repos: BackupRepo[]): BackupTaskView {
    const eff = effectiveTaskKind(task)
    const view: BackupTaskView = { ...task, legacyImgArchives: eff.legacyImgArchives }
    const datastore = datastoreOf(task, repos)
    if (datastore)
      view.datastore = datastore
    return view
  }

  /**
   * Resolve a stored `{ targetIqn, index }` LUN record to what the iSCSI read
   * layer says about it RIGHT NOW — the human name and the serial (backup2.9).
   * The answer the read layer gives, or `null` when it cannot answer (the LUN
   * is gone, or the read layer is unavailable): FAIL-OPEN, because a task list
   * must never die on the read layer, and "not resolvable" is a state the UI
   * shows, not an error it raises.
   */
  async function resolveLunRef(
    ref: { targetIqn: string, index: number },
  ): Promise<{ name: string | null, serial: string | null } | null> {
    try {
      const ctx = await readIscsiContext(executor, iscsiPaths)
      const targets = await buildIscsiTargets(ctx)
      const target = targets.find(t => t.iqn === ref.targetIqn)
      const lun = target?.luns.find(l => l.index === ref.index)
      if (!target || !lun)
        return null
      return { name: lun.name ? lun.name : null, serial: lun.serial ?? null }
    }
    catch (err) {
      server.log.warn(`[backup] LUN resolution for ${ref.targetIqn} LUN ${ref.index} failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  /**
   * Create/update guards: the schedule must be valid systemd calendar syntax and
   * the referenced repository must exist — as a tier-2 registered repo OR a
   * tier-1 PVE-defined repo (`pve:<id>`). Sends the 4xx and returns false on the
   * first failure.
   */
  async function guardTask(task: BackupTask, reply: FastifyReply): Promise<boolean> {
    // The EFFECTIVE expression — the one a cadence generated, when there is one.
    // systemd stays the authority on calendar syntax for generated expressions
    // exactly as it is for hand-written ones (16.10).
    const expression = effectiveSchedule(task)
    const schedule = await validateSchedule(executor, expression)
    if (!schedule.ok) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Invalid schedule '${expression}': ${schedule.error}` } })
      return false
    }
    const known = isPveRepoName(task.repository)
      ? (await readPbsStorages(paths.pveStorageCfg)).some(d => pveRepoName(d.id) === task.repository)
      : (await readBackupRepos(paths)).repos.some(r => r.name === task.repository)
    if (!known) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Repository '${task.repository}' is not registered` } })
      return false
    }
    // backup2.9 — a block task's group IS the LUN's durable identity: its
    // backupId must be `lun-<serial>` with the serial as the READ LAYER reads
    // it (a VPD fact that survives a rename, a re-point and a re-install). The
    // wizard derives the id from the pick, so this fires only for a client that
    // sends a different id for a LUN this node can see.
    if (task.kind === 'block') {
      // A record-less block task is refused by the shared schema already; the
      // branch stays as defence in depth (and so TS knows `lun` is a record
      // before it is used).
      const lun = task.archives[0]?.lun
      if (!lun) {
        reply.code(400)
        reply.send({
          error: {
            code: 'VALIDATION_ERROR',
            message: `A block task's archive must record the iSCSI LUN it backs up (target + LUN number).`,
          },
        })
        return false
      }
      const resolved = await resolveLunRef(lun)
      if (!resolved) {
        reply.code(400)
        reply.send({
          error: {
            code: 'VALIDATION_ERROR',
            message: `The block task's LUN ${lun.targetIqn} LUN ${lun.index} is not served by this node's iSCSI targets — pick a LUN from the backup wizard's LUN picker, which lists what this node actually serves.`,
          },
        })
        return false
      }
      if (resolved.serial && task.backupId !== lunBackupId(resolved.serial)) {
        reply.code(400)
        reply.send({
          error: {
            code: 'VALIDATION_ERROR',
            message: `A block task's backup ID is the LUN's serial: this LUN's is '${lunBackupId(resolved.serial)}'. '${task.backupId}' does not match, and the LUN's backups must stay one PBS group across renames and re-points.`,
          },
        })
        return false
      }
      // A serial the read layer cannot read right now cannot be verified — the
      // pick the wizard made is the only claim, and it is accepted (the same
      // fail-open the list's `lunName: null` is).
    }
    return true
  }

  /**
   * ident.2 (audit #14): refuse a task whose PBS group — (repository,
   * effective namespace, backup-id) — another task already writes. Two tasks
   * in one group prune each other's snapshots. `previous` is the stored task on
   * an edit: a task whose group did not change is never refused, so tasks that
   * already share a group from before this rule keep working (and keep their
   * history) until someone changes one of them. Sends the 409 and returns
   * false on a collision.
   */
  async function guardGroupUnique(task: BackupTask, reply: FastifyReply, previous?: BackupTask | null): Promise<boolean> {
    const [all, reg, pbs] = await Promise.all([
      readAllTasks(systemdDir),
      readBackupRepos(paths),
      readPbsStorages(paths.pveStorageCfg),
    ])
    const nsByRepo = new Map<string, string | undefined>(reg.repos.map(r => [r.name, r.namespace]))
    for (const def of pbs)
      nsByRepo.set(pveRepoName(def.id), def.namespace)
    const nsOf = (repository: string): string | undefined => nsByRepo.get(repository)
    if (previous && groupKeyUnchanged(previous, task, nsOf))
      return true
    const other = taskSharingGroup(task, all, nsOf)
    if (!other)
      return true
    reply.code(409)
    reply.send({
      error: {
        code: 'CONFLICT',
        reason: 'backup-group-in-use',
        message: sharedGroupMessage(task, other, task.namespace ?? nsOf(task.repository)),
      },
    })
    return false
  }

  // --- GET /backup/tasks — grid (LOCAL-ONLY status) -------------------------
  server.get('/backup/tasks', async () => {
    const [tasks, reg] = await Promise.all([readAllTasks(systemdDir), readBackupRepos(paths)])
    // Merge tier-1 PVE repos so a task targeting `pve:<id>` still joins its datastore.
    const joinRepos = await reposForJoin(reg.repos)
    const data = await Promise.all(
      tasks.map(async (task): Promise<BackupTaskEntry> => {
        const st = await deriveTaskStatus(executor, task)
        // rclone.3 human-pass finding 2 (backup parity): while the run actually
        // executes, the running DIRECT job's progress text rides on the row —
        // same rule, same helper, as the Cloud Sync grid.
        // rclone.5: the same lookup hands over the job's id (Cancel run's target).
        const entry: BackupTaskEntry = {
          task: toTaskView(task, joinRepos),
          lastRunResult: st.lastRunResult,
          lastRunAt: st.lastRunAt,
          nextRunAt: st.nextRunAt,
          overdue: st.overdue,
          ...(st.runActive ? runningDirectJobFields(jobQueue, task.name) : {}),
          ...(st.lastRunNote ? { lastRunNote: st.lastRunNote } : {}),
        }
        // backup2.9 — a block task's LUN NAME is read live: the unit stores the
        // record and the serial-derived id, never the display name (it can
        // change, and a stored copy would lie the moment it does). Fail-open
        // null: a LUN the read layer cannot resolve right now is shown as such,
        // and a broken read layer must not kill the task list.
        if (effectiveTaskKind(task).kind === 'block') {
          const lun = task.archives[0]?.lun
          if (lun) {
            const resolved = await resolveLunRef(lun)
            entry.lunName = resolved?.name ?? null
          }
          else {
            entry.lunName = null
          }
        }
        return entry
      }),
    )
    return { data }
  })

  // --- POST /backup/tasks/preview-nested — the wizard's boundary scan -------
  // USER-INITIATED, one-shot, NON-MUTATING and entirely LOCAL: an `st_dev` walk
  // of the source plus `findmnt` to name what it found. NO PBS contact at all —
  // this is the save-time verify pattern (the namespace check, `prune-preview`)
  // with nothing to verify remotely. It is registered BEFORE `/backup/tasks/:name`
  // so the literal segment can never be read as a task name.
  server.post('/backup/tasks/preview-nested', async (request, reply) => {
    const bodyParsed = BackupNestedPreviewRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid preview request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!req.path && !req.archives?.length) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: 'Send a path, or the archives to scan' } }
    }

    // backup2.4 — an `img` source is a device or an image file: `scanArchives`
    // skips the walk for it entirely and answers "no boundaries", so the row
    // still gets its derived consistency without anything being stat'ed.
    //
    // This is the INTERACTIVE scan: it rides the gateway's 15 s cross-node
    // forward, so it runs under the budget that fits under it
    // (NESTED_SCAN_PREVIEW_TIMEOUT_S). The run-start scan keeps its own, larger
    // budget — a backup is not a forward.
    const previewBudget = { timeoutSeconds: NESTED_SCAN_PREVIEW_TIMEOUT_S }
    const archives: BackupNestedScan[] = req.archives?.length
      ? await scanArchives(executor, req.archives.map(a => ({
          ...(a.name ? { name: a.name } : {}),
          path: a.path,
          includeNested: effectiveIncludeNested(a),
          ...(effectiveArchiveKind(a) === 'img' ? { kind: 'img' as const } : {}),
        })), previewBudget)
      : effectiveArchiveKind(req) === 'img'
        ? [imageArchiveScan(undefined, req.path as string)]
        : [await scanNestedFilesystems(executor, req.path as string, {
            includeNested: effectiveIncludeNested({ includeNested: req.includeNested ?? 'none' }),
            ...previewBudget,
          })]

    // backup2.3 — the DERIVED consistency rides the SAME response rather than a
    // second endpoint: both answers come from the one mount table this scan
    // already needed, plus the AHR topology. Read-only and additive; nothing in
    // any request body carries it back.
    const data: BackupNestedPreviewResponse = { archives: await withConsistency(archives) }
    return { data }
  })

  // --- GET /backup/lun-sources — the img archive's LUN picker ---------------
  // READ-ONLY and LOCAL-ONLY (the iSCSI read layer plus the same mount table the
  // consistency derivation already needs). NO PBS contact and NO `targetcli`:
  // this is the directory picker's block-storage sibling, a convenience over a
  // path field where free typing stays first-class.
  //
  // Registered BEFORE `/backup/tasks/:name` for the same reason `preview-nested`
  // is — it is a literal segment under the same prefix family and must never be
  // read as a task name.
  //
  // WHAT IS LEFT OUT, and why:
  //   - a LUN of a FOREIGN target (live-proof F7). The whole-image restore
  //     (backup2.7) refuses a target ANAS does not own, so offering its LUNs
  //     here would let a user back something up that can never be restored
  //     through the same product. The picker and the door now agree; a foreign
  //     target stays hands-off on both sides;
  //   - a LUN whose backing does not resolve onto storage ANAS knows (`foreign`)
  //     — ANAS cannot say what backs it, so it cannot say what backing it up
  //     would capture, and offering it in a picker would imply it can;
  //   - a PVE-owned volume: a guest disk (`vm-N-disk-M`) or a zvol on a
  //     PVE-managed pool. PVE territory is read-only and hands-off (3.25), and
  //     PVE backs its own guests up;
  //
  // A LUN whose backing path does not resolve right now is NOT hidden: a `zfs
  // rename` under a live LUN leaves exactly that (GT-40), and a row that
  // silently disappears explains nothing. It is listed with
  // `backingExists: false` and the screen says so.
  server.get('/backup/lun-sources', async (request, reply) => {
    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const ctx = await readIscsiContext(executor, iscsiPaths)
    const availability = iscsiAvailability(ctx)
    if (!availability.installed) {
      const empty: BackupLunSourceList = {
        installed: false,
        ...(availability.reason ? { reason: availability.reason } : {}),
        luns: [],
      }
      return { data: empty }
    }

    const targets = await buildIscsiTargets(ctx)
    // One fact read for every LUN's consistency — the same derivation the
    // wizard's preview uses, so the picker and the row agree by construction.
    let facts: ConsistencyFacts | null = null
    try {
      facts = await readConsistencyFacts(executor, readAhrPools, { pveStorageCfg: paths.pveStorageCfg })
    }
    catch (err) {
      server.log.warn(`[backup] LUN-source consistency derivation failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    const luns: BackupLunSource[] = []
    for (const target of targets) {
      // F7 — ANAS-owned targets only. `deriveOwnership` is the ONE authority
      // (iscsi.2), and it is the same answer `POST /v1/backup/restore` checks
      // before an image restore, so the two doors cannot drift apart.
      if (target.ownership !== 'anas')
        continue
      for (const lun of target.luns) {
        // `foreign` = positively not ANAS storage; `unresolved` (iscsi.5) = resolves onto
        // no known storage NOW — either way ANAS cannot say what a backup would capture.
        if (lun.kind === 'foreign' || lun.kind === 'unresolved' || !lun.backingPath.startsWith('/'))
          continue
        const classification = classifyBacking(lun.backingPath, ctx.inputs)
        // pvepool.1: hide only a LUN whose backing DATASET is inside PVE's
        // footprint (any kind) — a LUN backed by a sibling dataset of a PVE
        // pool is a legitimate source and stays listed.
        if (classification.pveOwned)
          continue
        luns.push({
          targetIqn: target.iqn,
          index: lun.index,
          name: lun.name,
          kind: lun.kind,
          path: lun.backingPath,
          serial: lun.serial,
          size: lun.size,
          backingExists: lun.backingExists,
          ...(facts ? { consistency: deriveConsistency(lun.backingPath, facts) } : {}),
        })
      }
    }

    const data: BackupLunSourceList = { installed: true, luns }
    return { data }
  })

  // --- GET /backup/tasks/:name — detail ------------------------------------
  server.get<{ Params: { name: string } }>('/backup/tasks/:name', async (request, reply) => {
    const nameParsed = BackupName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid task name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const task = await readTask(systemdDir, name)
    if (!task) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Backup task '${name}' not found` } }
    }

    // backup2.2 — the boundary scan is no longer part of the detail. It is a
    // local `st_dev` walk, and for a source ROOTED on a remote mount it ran
    // over the network until its wall-clock cap — past the gateway's 15 s
    // forward timeout, so a slow (but reachable) node read as "unreachable" and
    // the detail hung for twenty seconds on a screen the operator opened for
    // the task, not for a scan. The detail is instant now; the UI loads the
    // boundary scan progressively through POST /backup/tasks/preview-nested,
    // which rides that same forward and runs under the budget that fits under
    // it (NESTED_SCAN_PREVIEW_TIMEOUT_S). An ABSENT `nested` key still means
    // "not known" to the UI, so the schema's optional field is untouched.
    const [reg, st, units, journal] = await Promise.all([
      readBackupRepos(paths),
      deriveTaskStatus(executor, task),
      readUnitTexts(systemdDir, name),
      readRecentJournal(executor, name),
    ])
    const joinRepos = await reposForJoin(reg.repos)
    // The last run's NOTES (backup2 fix-ups): the run's completion toast points
    // the operator to THIS window for them. Run jobs are in-process state —
    // after a daemon restart the last run's result is honestly unknown, and the
    // key stays absent rather than claiming "none".
    const lastRunJob = jobQueue.findByOperation('backup.task.run', name, 'task')
    const lastRunResult = lastRunJob?.status === 'completed'
      ? (lastRunJob.result as { notices?: unknown } | null)
      : undefined
    const lastRunNotices = Array.isArray(lastRunResult?.notices)
      ? lastRunResult.notices.filter((n): n is string => typeof n === 'string')
      : undefined
    const detail: BackupTaskDetail = {
      task: toTaskView(task, joinRepos),
      lastRunResult: st.lastRunResult,
      lastRunAt: st.lastRunAt,
      nextRunAt: st.nextRunAt,
      overdue: st.overdue,
      ...(st.runActive ? runningDirectJobFields(jobQueue, name) : {}),
      ...(st.lastRunNote ? { lastRunNote: st.lastRunNote } : {}),
      unit: units.unit,
      timer: units.timer,
      ...(journal ? { journal } : {}),
      // F9 — when there is no result to show, say WHY on the one screen that has
      // room for the sentence. The journald tail is the only history a disabled
      // task has left, and it is already labelled recent-only.
      ...(st.lastRunResult === 'disabled' ? { statusNote: DISABLED_HISTORY_NOTE } : {}),
      ...(lastRunNotices?.length ? { lastRunNotices } : {}),
    }
    return { data: detail }
  })

  // --- The backup-task guard specs (story cr.41, WAVE3-DESIGN §3.3 Unit-store
  // row + the operator's Q1 ruling) ------------------------------------------
  //
  // One spec per verb, both doors: the route answers a refusal in the request,
  // the job re-reads the unit store and refuses again before it writes or
  // removes. Locks are `task:backup:<name>` — exclusive for create, update and
  // delete, SHARED for the DIRECT run (§4.2) — so a delete queued during a run
  // waits for the run and re-gates, and a create cannot race a delete or an
  // earlier create of the same name.

  const backupTaskView = (name: string): ObjectView<UnitTaskObject<BackupTask>> => ({
    what: `Backup task '${name}'`,
    read: () => readUnitTaskObject(readTask, readUnitTexts, systemdDir, name),
    id: async o => ({ task: o.task.name }),
    notFound: () => ({ status: 404, code: 'NOT_FOUND', message: `Backup task '${name}' not found` }),
    unbound: () => `Could not read backup task '${name}' — refusing`,
  })

  /**
   * The Q1 active-run gate: the direct run job, or the unit systemd reports
   * active. cr.41b: the read FAILS CLOSED — a `systemctl show` that cannot
   * answer refuses rather than reading "not running", because an unreadable run
   * state is not evidence the run is over and a delete must not remove a unit
   * whose run it could not see (guards fail loud).
   */
  async function backupTaskActiveRunGate(name: string): Promise<Refusal | null> {
    try {
      const inFlight = await taskRunInFlight(jobQueue, 'backup.task.run', executor, BACKUP_UNIT_KIND, name)
      return inFlight.job || inFlight.unit ? activeRunDeleteRefusal(`Backup task '${name}'`, inFlight) : null
    }
    catch {
      return runStateUnreadableRefusal(`Backup task '${name}'`)
    }
  }

  /** A create's object is the name SLOT: existence is a gate, re-run in the job under the name key. */
  function backupTaskCreateSpec(name: string): GuardSpec<{ existing: BackupTask | null }> {
    return {
      operation: 'backup.task.create',
      object: {
        what: `Backup task '${name}'`,
        read: async () => ({ existing: await readTask(systemdDir, name) }),
        id: async () => ({ task: name }),
        unbound: () => `Could not read backup tasks — refusing`,
      },
      gates: [async o => (o.existing
        ? { status: 409, code: 'CONFLICT', message: `Backup task '${name}' already exists` }
        : null)],
      locks: async () => [taskClaim('backup', name, 'exclusive')],
    }
  }

  function backupTaskUpdateSpec(name: string): GuardSpec<UnitTaskObject<BackupTask>> {
    return {
      operation: 'backup.task.update',
      object: { ...backupTaskView(name), revision: async o => serviceUnitRevision(o.unit) },
      gates: [],
      locks: async () => [taskClaim('backup', name, 'exclusive')],
    }
  }

  function backupTaskDeleteSpec(name: string): GuardSpec<{ unit: string, timer: string }> {
    return {
      operation: 'backup.task.remove',
      // cr.41b: the delete's object is the unit AS STORED — the stores' own
      // existence (a `.service` on disk), never the parsed task. A unit whose
      // X-ANAS-Task no longer parses (a hand edit; a task an older ANAS wrote)
      // is skipped by the list AND by a parsed-object read, which would answer
      // 404 on exactly the unit the operator needs to remove — this read makes
      // it deletable. The UPDATE spec above stays bound to the parsed object:
      // an edit cannot be bound to bytes that do not parse — 404 not-found is
      // right there.
      object: {
        what: `Backup task '${name}'`,
        read: () => readUnitStoreEntry(readUnitTexts, systemdDir, name),
        id: async () => ({ task: name }),
        notFound: () => ({ status: 404, code: 'NOT_FOUND', message: `Backup task '${name}' not found` }),
        unbound: () => `Could not read backup task '${name}' — refusing`,
      },
      gates: [async () => backupTaskActiveRunGate(name)],
      locks: async () => [taskClaim('backup', name, 'exclusive')],
    }
  }

  // --- POST /backup/tasks — create -----------------------------------------
  server.post('/backup/tasks', async (request, reply) => {
    // ident.2 (audit #14): a NEW task with no backup-id gets `<host>-<task>`,
    // never the bare hostname a plain host backup of this node also writes.
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? { ...(request.body as Record<string, unknown>) }
      : request.body
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const o = body as Record<string, unknown>
      const id = o.backupId
      if (typeof o.name === 'string' && (id === undefined || id === null || (typeof id === 'string' && id.trim() === '')))
        o.backupId = defaultBackupId(backupNodename(), o.name)
    }
    const bodyParsed = BackupTaskRequest.safeParse(body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid backup task: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const task = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Story cr.41: the create's existence gate runs here AND again in the job
    // under the `task:backup:<name>` name key — two creates of one name cannot
    // both pass a check made before either wrote.
    const spec = backupTaskCreateSpec(task.name)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    if (!(await guardTask(task, reply)))
      return reply
    if (!(await guardGroupUnique(task, reply)))
      return reply

    const job = jobQueue.submit(
      'backup.task.create',
      { ...identity, params: { task: task.name } },
      guarded(spec, pre, async () => {
        await writeTaskUnits(executor, systemdDir, task)
        return { created: task.name }
      }),
      { locks: pre.locks },
    )
    reply.code(202)
    return { job }
  })

  // --- PUT /backup/tasks/:name — update / enable / disable ------------------
  server.put<{ Params: { name: string } }>('/backup/tasks/:name', async (request, reply) => {
    const nameParsed = BackupName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid task name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const bodyParsed = BackupTaskRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid backup task: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const task = bodyParsed.data
    if (task.name !== name) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Task name in body ('${task.name}') does not match URL ('${name}')` } }
    }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Story cr.41: the update is BOUND to the stored task's revision (the
    // service unit's sha256) — an edit whose unit changed meanwhile refuses
    // STATE_CHANGED, and one whose task was deleted refuses not-found, so an
    // update can never resurrect a deleted task. `pre.object.task` is the SAME
    // re-read the group check compared against.
    const spec = backupTaskUpdateSpec(name)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    if (!(await guardTask(task, reply)))
      return reply
    if (!(await guardGroupUnique(task, reply, pre.object.task)))
      return reply

    const job = jobQueue.submit(
      'backup.task.update',
      { ...identity, params: { task: name } },
      guarded(spec, pre, async () => {
        await writeTaskUnits(executor, systemdDir, task)
        return { updated: name }
      }),
      { locks: pre.locks },
    )
    reply.code(202)
    return { job }
  })

  // --- DELETE /backup/tasks/:name — remove the units (PBS data untouched) ---
  server.delete<{ Params: { name: string } }>('/backup/tasks/:name', async (request, reply) => {
    const nameParsed = BackupName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid task name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Q1 (cr.41): a delete during an ACTIVE run refuses at the route AND again
    // in the job — a run that started while the delete waited (for a slot or
    // for the task's key) is seen and refused, not removed under. The sentence
    // names the run (job id or unit) and says how to cancel it.
    const spec = backupTaskDeleteSpec(name)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    const job = jobQueue.submit(
      'backup.task.remove',
      { ...identity, params: { task: name } },
      guarded(spec, pre, async () => {
        await removeTaskUnits(executor, systemdDir, name)
        return { removed: name }
      }),
      { locks: pre.locks },
    )
    reply.code(202)
    return { job }
  })

  // --- POST /backup/tasks/:name/run — Run Now ------------------------------
  // TWO paths, one endpoint (the recursion guard is the `direct` flag):
  //   • UI Run-Now (no `direct`): the job STARTS the task's own systemd unit and
  //     supervises it to completion — so a manual run lands in systemd's
  //     last-result and the unit journal exactly like a scheduled run (one code
  //     path, one history). Supervision is LOCAL-ONLY (systemd + journald).
  //   • The unit's OWN execution (`direct:true`, from the backup-task helper the
  //     timer / `systemctl start` fires): runs pbc IN the daemon. It NEVER
  //     re-enters systemctl — that is what keeps the two paths from recursing.
  server.post<{ Params: { name: string } }>('/backup/tasks/:name/run', async (request, reply) => {
    const nameParsed = BackupName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid task name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const bodyParsed = BackupRunRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid run request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const direct = bodyParsed.data.direct === true

    const identity = requireIdentity(request, reply)
    if (!identity)
      return
    // cr.56 (review L10): `direct` is the runner's flag — it skips the
    // in-flight refusal below and runs the work without the task's unit — so
    // it is taken only from the runner's own identity, which no request
    // through the gateway can carry (runner-poll.ts TASK_RUNNER_USER).
    if (direct && identity.user !== TASK_RUNNER_USER)
      return sendRefusal(reply, directFromClientRefusal(`Backup task '${name}'`))

    if (!(await taskFileExists(systemdDir, name))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Backup task '${name}' not found` } }
    }

    // rclone.3 human-pass finding 1 (backup parity — the same gate, the same
    // sentence shape, as the Cloud Sync run door): a run already in flight
    // refuses the door with the run named. The supervision's own attach
    // behaviour stays for the timer-vs-manual race; this gate is for the USER
    // who can see the row. When the task's direct run is executing, its live
    // progress quotes in the sentence.
    if (!direct) {
      const run = await readRunActive(executor, name)
      if (run.active) {
        reply.code(409)
        return {
          error: {
            code: 'CONFLICT',
            message: runningRunConflictMessage(name, run, runningDirectJobProgress(jobQueue, name)),
          },
        }
      }
    }

    // cr.33b (§4.3): the DIRECT run — the one that reads the source — holds
    // SHARED claims on the filesystem every source path lives on (the zfs:
    // dataset, ahr: pool and mount: keys the destructive verbs take, resolved
    // the way the consistency derivation resolves a path), so a destroy,
    // rename, rollback or unmount of a source accepted meanwhile waits for
    // the run and re-gates after it. The Run-Now SUPERVISOR takes none: it
    // waits for the direct run its unit submits, so a destroy queued between
    // the two (per-key FIFO) would wait for the supervisor while the direct
    // run waited for the destroy. The task is read here for its paths; the
    // body reads it again and — cr.56 (review M2) — recomputes the claims from
    // ITS read and refuses STATE_CHANGED when it needs one the job does not
    // hold (an archive path edited onto another filesystem while the run
    // waited behind the update that holds the task key).
    const sourceTask = direct ? await readTask(systemdDir, name) : null
    const source = sourceTask
      ? await pathSourceClaims(executor, sourceTask.archives.map(a => a.path), readAhrPools)
      : { claims: [], unlocked: [] }
    // cr.41 (§4.2 task key, cr.33b constraint): ONLY the DIRECT run holds the
    // task's key — shared — because it is the one that reads the task and does
    // the work. The Run-Now SUPERVISOR holds NO task key (and no source claim):
    // it waits for the direct run its unit submits, so a queued delete would
    // otherwise wait for the supervisor while the direct run waited for the
    // delete — a per-key FIFO deadlock.
    const runClaims = [...source.claims, ...(direct ? [taskClaim('backup', name, 'shared')] : [])]

    const job = jobQueue.submit(
      'backup.task.run',
      { ...identity, params: { task: name, ...(direct ? { direct: true } : {}) } },
      async (updateProgress, ctx) => {
        if (!direct) {
          // The manual/UI path: run through the task's own unit and supervise it.
          return superviseRun(executor, name, { onProgress: updateProgress })
        }
        const unlocked = unlockedSourcesLine(source.unlocked)
        if (unlocked)
          updateProgress(`backup task '${name}': ${unlocked}`)
        // rclone.5 (backup parity): the direct run is cancellable from its first
        // line — the SAME hook shape the cloud run registers (child-cancel.ts),
        // SIGINT to proxmox-backup-client; the transient snapshots are still
        // destroyed in runBackup's finally.
        const cancel = new ChildCancel(ctx, 'proxmox-backup-client', {
          subject: `Backup task '${name}'`,
          consequence: BACKUP_CANCEL_CONSEQUENCE,
        })
        // rclone.5 review (backup parity): an accepted cancel ends the run at
        // the NEXT pre-flight boundary, not after it — the guard, the repo
        // lookup, the transient snapshots and the exec each get one (the
        // service takes its own through `checkCancel`;
        // `assertRunNotCancelled` is the one shared check).
        // The unit's own execution: run pbc in the daemon (NEVER systemctl).
        const task = await readTask(systemdDir, name)
        if (!task)
          throw new Error(`Backup task '${name}' not found`)

        // 16.12: this branch is the ONE place every real run converges (a timer
        // fire and a UI Run Now both arrive here through the task's own unit),
        // so it is also the one place a run notification is emitted. What is
        // known when the run ends rides the notification, which is why the repo
        // is tracked outside the try — a failure before it resolves still names
        // the task's configured repository.
        const startedAt = Date.now()
        let repo: BackupRepo | undefined
        let namespace: string | undefined
        try {
          assertRunNotCancelled(cancel, 'the cadence gate')
          // Cadence gate (16.10): a biweekly task runs on a WEEKLY timer because
          // OnCalendar cannot say "every other week", so an off-week SCHEDULED fire
          // stops here. It completes as a first-class, visible skip — a journal
          // line, an exit status systemd counts as success, and a `skipped` task
          // status — never a fake success-with-backup and never a failure. A Run Now
          // is not gated (explicit user intent), and every other cadence is pure
          // OnCalendar with nothing to gate. It NEVER notifies (16.12): the gate
          // produced no run, and the cron jobs it replaces produced no mail.
          const gate = await gateRun(executor, task)
          if (!gate.run) {
            updateProgress(`backup task '${name}': ${gate.detail}`)
            return { status: BACKUP_SKIPPED_OFF_WEEK, archives: [], reason: gate.detail }
          }
          if (gate.reason === 'heal' || gate.reason === 'no-record')
            updateProgress(`backup task '${name}': ${gate.detail}`)

          // cr.56 (review M2): the claim-bearing field is the archive PATHS
          // (each resolved to the filesystem it lives on). The keys the queue
          // granted were computed from the route's read; the run backs up what
          // THIS read says, so every key this read needs must be held — or a
          // destroy, rollback or unmount accepted meanwhile is not serialised
          // against it. Recomputed rather than bound as a revision: the keys
          // also move when the filesystem under an unchanged path moves (a
          // pool re-created under its name, a mount over the path).
          const needed = await pathSourceClaims(executor, task.archives.map(a => a.path), readAhrPools)
          const moved = unheldClaimsRefusal(
            `Backup task '${name}'`,
            sourcePathsMoved({ name: 'archive paths', plural: true }, (sourceTask?.archives ?? []).map(a => a.path), task.archives.map(a => a.path)),
            source.claims,
            needed.claims,
          )
          if (moved)
            throw new GuardRefusalError(moved)

          assertRunNotCancelled(cancel, 'the repository lookup')
          // Resolve tier-2 (registry) or tier-1 (pve:<id>) repo + secret FRESH.
          // A tier-1 secret is read from /etc/pve/priv/storage/<id>.pw here, at
          // exec time — never copied, never cached (PVE rotation is instant).
          const resolved = await resolveRepoAndSecret(task.repository)
          if (!resolved)
            throw new Error(`Repository '${task.repository}' is not registered`)
          const secret = resolved.secret
          repo = resolved.repo
          namespace = effectiveNamespace(task, repo)
          if (secret === null) {
            throw new Error(isPveRepoName(task.repository)
              ? `No PBS credential file for '${task.repository}' (${paths.pvePrivStorageDir}/${pveStorageId(task.repository)}.pw is missing) — set it in Datacenter → Storage`
              : `No secret stored for repository '${repo.name}' — set its credentials first`)
          }
          const result = await runBackup(
            executor,
            // The consistency derivation reads the SAME storage.cfg the rest of
            // the backup routes do (the zvol branch's PVE hands-off guard), and
            // the source guard (backup2.11) reads the SAME fstab the Mounts
            // routes and `preview-nested` do.
            { task, repo, secret, fstabPath, consistencyOptions: { pveStorageCfg: paths.pveStorageCfg }, onSpawn: cancel.onSpawn, checkCancel: next => assertRunNotCancelled(cancel, next) },
            updateProgress,
          )
          // A cancel never prunes and never notifies (rclone.5): the operator
          // stopped it and the row says so; one journald line records it.
          if (cancel.requested())
            return logCancelledRun(name)
          // Retention (16.11): prune ONLY after a run that actually backed up. A
          // 'skipped' run (the benign too-soon collision — and any future cadence
          // skip) never prunes, and a FAILED run threw long before this line. A
          // task with no retention prunes nothing at all (the default posture);
          // a prune failure rides back as a warning, never a job failure.
          let final = result
          if (result.status === 'success') {
            const pruned = await pruneAfterBackup(executor, {
              task,
              repo,
              secret,
              onProgress: updateProgress,
              log: (message, level) => (level === 'warn' ? server.log.warn(message) : server.log.info(message)),
            })
            // MERGE the warning lists rather than letting the spread clobber
            // them: the run already carries this story's nested-filesystem
            // omissions (backup2.2), and a prune warning must not erase them.
            const warnings = [...(result.warnings ?? []), ...(pruned.warnings ?? [])]
            final = {
              ...result,
              ...pruned,
              ...(warnings.length ? { warnings } : {}),
            }
          }
          // Best-effort by contract: notifyBackupRun never throws, so a broken
          // mail target cannot turn a good backup into a failed job.
          await notifyBackupRun(executor, { task, repo, namespace, result: final, elapsedMs: Date.now() - startedAt })
          return final
        }
        catch (err) {
          // The boundary check's throw IS the cancellation, and so is a run
          // that had a child to be stopped (rclone.5 review, backup parity):
          // the queue's own settle awaits the hook, so the verdict is
          // `cancelled` whatever microtask order the child's death arrived in.
          if (err instanceof JobCancelledError || (cancel.requested() && cancel.stoppedOnPurpose()))
            return logCancelledRun(name)
          const message = err instanceof Error ? err.message : String(err)
          await notifyBackupRun(executor, { task, repo, namespace, error: message, elapsedMs: Date.now() - startedAt })
          // An accepted cancel with nothing that could take a signal (rclone.5
          // review): the child never spawned — the exec rejected before
          // anything ran — so the honest verdict is this failure, marked for
          // the queue to end the job `failed` with the cancel in the reason.
          if (cancel.requested())
            throw new JobFailedDespiteCancelError(message)
          throw err
        }
      },
      // cr.33 (§4.3): the direct run is a data mover and rides the long lane
      // (at most 3 of the 4 slots). cr.49: the Run-Now supervisor only watches
      // the unit, so it rides the watch lane (its own slots, no claims) and its
      // direct run never waits behind it. cr.41: the task key rides the DIRECT
      // run only (runClaims is empty for the supervisor), so a queued delete
      // cannot deadlock the pair under per-key FIFO.
      { lane: direct ? 'long' : 'watch', locks: runClaims },
    )
    reply.code(202)
    return { job }
  })

  // --- POST /backup/tasks/:name/prune-preview — dry-run retention preview ----
  // USER-INITIATED, one-shot, NON-MUTATING (`--dry-run`): the wizard's Preview
  // button. It is the second (and last) PBS contact this story sanctions, the
  // save-time namespace-verify precedent reapplied — never polled, never
  // background. Every field may be supplied inline so an UNSAVED task can be
  // previewed; omitted fields fall back to the stored task's own values.
  server.post<{ Params: { name: string } }>('/backup/tasks/:name/prune-preview', async (request, reply) => {
    const nameParsed = BackupName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid task name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const bodyParsed = BackupPrunePreviewRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid preview request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const stored = await readTask(systemdDir, name)
    const repository = req.repository ?? stored?.repository
    const backupId = req.backupId ?? stored?.backupId
    const retention = req.retention ?? stored?.retention
    if (!repository || !backupId) {
      reply.code(400)
      return {
        error: {
          code: 'VALIDATION_ERROR',
          message: `Backup task '${name}' is not saved yet — send repository and backupId with the preview request`,
        },
      }
    }
    if (!hasRetentionKeeps(retention)) {
      reply.code(400)
      return {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Set at least one retention keep before previewing — with no keep flags PBS keeps everything, so ANAS never runs prune',
        },
      }
    }

    const resolved = await resolveRepoAndSecret(repository)
    if (!resolved) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Repository '${repository}' not found` } }
    }
    const { repo, secret } = resolved
    if (secret === null) {
      reply.code(400)
      return {
        error: {
          code: 'VALIDATION_ERROR',
          message: isPveRepoName(repository)
            ? `No PBS credential file for '${repository}' — set it in Datacenter → Storage`
            : `No secret stored for repository '${repo.name}' — set its credentials first`,
        },
      }
    }

    // Effective namespace: the request's, else the stored task's, else the
    // repo's own — the same fallback the run path uses.
    const namespace = req.namespace ?? stored?.namespace ?? repo.namespace
    const outcome = await runPrune(executor, {
      repo,
      secret,
      backupId,
      ...(namespace ? { namespace } : {}),
      retention: retention as NonNullable<typeof retention>,
      dryRun: true,
    })

    const data: BackupPrunePreviewResponse = outcome.ok
      ? { verdict: 'ok', result: outcome.result }
      : { verdict: outcome.verdict, detail: outcome.detail }

    // Fire-and-forget audit record (journald) — mirrors the repo Test endpoint.
    jobQueue.submit(
      'backup.task.prune-preview',
      { ...identity, params: { task: name, repo: repo.name, group: pruneGroup(backupId) } },
      async () => ({ verdict: data.verdict }),
    )
    return { data }
  })

  // ==========================================================================
  //  Restore reads (story backup2.5) — user-initiated PBS contacts
  //
  //  Three READS, all 200 (never a job — nothing changes anywhere). They join
  //  the run, the Test and the prune preview on Epic 16's sanctioned-contact
  //  list; phase 2 added exactly these. Nothing here is ever polled: each call
  //  is a click.
  //
  //  A LOCAL fault (unknown task, unknown repository, no stored credential) is
  //  a 4xx — it is ANAS's own resource that is wrong. A PBS-side outcome is a
  //  200 carrying a VERDICT, the prune-preview / repo-Test pattern: the picker
  //  renders one message either way, and "diagnose, don't just fail" holds.
  // ==========================================================================

  /**
   * Resolve a repository reference to the repo + its FRESH secret, or send the
   * 404 / 400 that says which local thing is missing. Returns null when it has
   * already replied.
   */
  async function readDepsFor(
    reference: string,
    reply: FastifyReply,
    namespaceOverride?: string,
  ): Promise<{ repo: BackupRepo, secret: string, namespace?: string } | null> {
    const resolved = await resolveRepoAndSecret(reference)
    if (!resolved) {
      reply.code(404)
      reply.send({ error: { code: 'NOT_FOUND', message: `Repository '${reference}' not found` } })
      return null
    }
    const { repo, secret } = resolved
    if (secret === null) {
      reply.code(400)
      reply.send({
        error: {
          code: 'VALIDATION_ERROR',
          message: isPveRepoName(reference)
            ? `No PBS credential file for '${reference}' — set it in Datacenter → Storage`
            : `No secret stored for repository '${repo.name}' — set its credentials first`,
        },
      })
      return null
    }
    // The effective namespace: the caller's, else the repo's own (a PVE-defined
    // storage often carries one) — the same fallback every other path uses.
    const namespace = namespaceOverride ?? repo.namespace
    return { repo, secret, ...(namespace ? { namespace } : {}) }
  }

  /**
   * A restore's repository and secret as they are when its JOB starts (cr.56,
   * folded from cr.54's report) — read fresh, as the backup run reads them in
   * its job, never the value the route captured: a restore can wait hours in
   * the queue behind long data movers, and a token rotated meanwhile (a PVE
   * storage's .pw changes the moment the operator saves it) must not fail the
   * restore, nor a deleted credential still be used. The repository must still
   * be the one the route read the snapshot from — the same host, port and
   * datastore; another address is another server, whose snapshot of that name
   * nobody picked, so the job refuses STATE_CHANGED before anything runs. Its
   * auth details (token id, fingerprint) are taken as they are now, beside the
   * secret they belong with.
   */
  async function restoreDepsNow(reference: string, atRoute: BackupRepo): Promise<{ repo: BackupRepo, secret: string }> {
    const resolved = await resolveRepoAndSecret(reference)
    if (!resolved) {
      throw new GuardRefusalError({
        status: 404,
        code: 'NOT_FOUND',
        message: `Repository '${reference}' is no longer configured — nothing was restored`,
      })
    }
    const { repo, secret } = resolved
    const where = (r: BackupRepo): string => `${r.host}:${r.port}/${r.datastore}`
    if (where(repo) !== where(atRoute)) {
      throw new GuardRefusalError({
        status: 409,
        code: 'STATE_CHANGED',
        message: `Repository '${reference}' changed while the restore waited (was ${where(atRoute)}; now ${where(repo)}) `
          + `— the snapshot was picked from the old one, so nothing was restored; pick it again`,
      })
    }
    if (secret === null) {
      throw new Error(isPveRepoName(reference)
        ? `No PBS credential file for '${reference}' (${paths.pvePrivStorageDir}/${pveStorageId(reference)}.pw is missing) — set it in Datacenter → Storage; nothing was restored`
        : `No secret stored for repository '${repo.name}' — set its credentials first; nothing was restored`)
    }
    return { repo, secret }
  }

  // --- GET /backup/tasks/:name/snapshots — the task's points in time --------
  //
  // The task knows its repository, its effective namespace and its backup-id,
  // so the caller supplies nothing: one click, one listing of its own group.
  // GT-1: the client's JSON has no composite id — listSnapshots composes it;
  // GT-2: the client's array is unsorted, so it comes back newest-first.
  server.get<{ Params: { name: string } }>('/backup/tasks/:name/snapshots', async (request, reply) => {
    const nameParsed = BackupName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid task name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const task = await readTask(systemdDir, name)
    if (!task) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Backup task '${name}' not found` } }
    }

    const deps = await readDepsFor(task.repository, reply, task.namespace)
    if (!deps)
      return

    // PBS file backups are always type `host` (16.1 ground truth) — the group
    // is `host/<backup-id>`, never derived from the hostname.
    const group = composeGroupId('host', task.backupId)
    const outcome = await listSnapshots(executor, deps, group)
    const data: BackupSnapshotList = outcome.ok
      ? {
          verdict: 'ok',
          repository: task.repository,
          ...(deps.namespace ? { namespace: deps.namespace } : {}),
          group,
          snapshots: outcome.data,
        }
      : {
          verdict: outcome.verdict,
          detail: outcome.detail,
          repository: task.repository,
          ...(deps.namespace ? { namespace: deps.namespace } : {}),
          group,
          snapshots: [],
        }
    return { data }
  })

  // --- GET /backup/repos/:name/groups?ns=&group= — the TASK-LESS door -------
  //
  // For archives whose task was renamed or deleted: list a namespace's groups,
  // or (with ?group=) that group's snapshots in exactly the same shape the task
  // endpoint returns — one picker, one parser, two doors.
  server.get<{
    Params: { name: string }
    Querystring: { ns?: string, group?: string }
  }>('/backup/repos/:name/groups', async (request, reply) => {
    const refParsed = BackupRepoRef.safeParse(request.params.name)
    if (!refParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid repository name: ${refParsed.error.issues[0]?.message}` } }
    }
    const reference = refParsed.data
    const requestedNs = request.query.ns?.trim() || undefined
    const requestedGroup = request.query.group?.trim() || undefined

    const deps = await readDepsFor(reference, reply, requestedNs)
    if (!deps)
      return

    const base = {
      repository: reference,
      ...(deps.namespace ? { namespace: deps.namespace } : {}),
    }

    if (requestedGroup) {
      const outcome = await listSnapshots(executor, deps, requestedGroup)
      const data: BackupGroupList = outcome.ok
        ? { verdict: 'ok', ...base, groups: [], group: requestedGroup, snapshots: outcome.data }
        : { verdict: outcome.verdict, detail: outcome.detail, ...base, groups: [], group: requestedGroup, snapshots: [] }
      return { data }
    }

    const outcome = await listGroups(executor, deps)
    const data: BackupGroupList = outcome.ok
      ? { verdict: 'ok', ...base, groups: outcome.data }
      : { verdict: outcome.verdict, detail: outcome.detail, ...base, groups: [] }
    return { data }
  })

  // --- POST /backup/restore/browse — ONE directory level of an archive ------
  //
  // A POST because the key is compound (repo + ns + snapshot + archive + path),
  // not because anything changes. cr.48: a READ job (202, the level in
  // `job.result`) with a five-minute ceiling and a Cancel — the catalog fetch
  // of a large archive over a slow link can take minutes. The validation and
  // the repository/secret read answer before the 202. The driver is `catalog
  // shell` over a pipe, wrapped in `timeout` — NEVER the FUSE `mount`, whose
  // black-holed-server D-state readers cannot be killed at all (GT-33).
  server.post('/backup/restore/browse', async (request, reply) => {
    const parsed = BackupBrowseRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid browse request: ${parsed.error.issues[0]?.message}` } }
    }
    const req = parsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const deps = await readDepsFor(req.repo, reply, req.ns?.trim() || undefined)
    if (!deps)
      return

    const job = jobQueue.submit(
      READ_JOB_OPERATIONS.backupCatalog,
      { ...identity, params: { repo: req.repo, snapshot: req.snapshot, archive: req.archive, path: req.path } },
      async (_progress, ctx): Promise<BackupBrowseResult> => {
        const cancel = readJobCancel(ctx, 'proxmox-backup-client catalog shell', `Listing of '${req.path}' in ${req.archive}`)
        return browseArchiveLevel(executor, {
          ...deps,
          snapshot: req.snapshot,
          archive: req.archive,
          path: req.path,
          onSpawn: cancel.onSpawn,
          checkpoint: cancel.checkpoint,
        })
      },
    )
    reply.code(202)
    return { job }
  })

  // --- POST /backup/restore — the restore family ---------------------------
  //
  // ONE endpoint, one dispatch per restore KIND, because the two kinds are
  // genuinely different operations: files are SELECTIVE (pick a subtree, merge
  // or restore beside it), block images are WHOLE (the LUN is rewritten end to
  // end and LIO stands down while it happens). Sharing a handler between them
  // would mean a body where half the fields are inert on any given call.
  //
  // Each branch is one call into its own service, and the `switch` is the whole
  // join: `backup2.7` built the image half, `backup2.6` the file half, and
  // neither knows anything about the other.
  server.post('/backup/restore', async (request, reply) => {
    const parsed = BackupRestoreRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      // Name the FIELD, not just the shape. A restore body is long enough that
      // "expected array, received undefined" identifies nothing on its own, and
      // the two kinds have different fields — so which one is wrong is exactly
      // the thing the caller needs told (backup2.6 merge fix-up).
      const issue = parsed.error.issues[0]
      const where = issue?.path.length ? `${issue.path.join('.')}: ` : ''
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid restore request: ${where}${issue?.message}` } }
    }
    const req = parsed.data

    switch (req.kind) {
      case 'image':
        return restoreImage(request, reply, req)
      case 'files':
      default:
        return restoreFiles(request, reply, req)
    }
  })

  // --- The WHOLE-IMAGE branch (story backup2.7) ----------------------------
  //
  // The pre-flight order below is the story's, and it is an order rather than a
  // set: EVERY refusal happens before anything destructive is called, and the
  // cheapest, most local checks come first so a node with no LIO never reaches
  // the PBS server at all.
  //
  //   1. LIO installed, and the live tree is not a degraded restore
  //   2. the target exists, is ANAS-owned, has that LUN
  //   3. the LUN's backing is a zvol or an image file, and it is THERE
  //   4. the snapshot exists and the archive is in it
  //   5. the manifest's image size EQUALS the target's size           <- GT-42
  //   6. no live session on the target                                <- entry gate
  //   7. the confirm gate (409 + X-Anas-Confirm-Code)
  //
  // Only then is a job submitted, and only inside that job does anything change.
  async function restoreImage(
    request: FastifyRequest,
    reply: FastifyReply,
    req: BackupImageRestoreRequest,
  ) {
    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!confirmStore) {
      reply.code(503)
      return {
        error: {
          code: 'UNAVAILABLE',
          message: 'The confirmation store is not configured, so this data-destroying operation cannot be gated. '
            + 'Restore is refused rather than run unguarded.',
        },
      }
    }

    // (1) LIO present, and not mid-degraded-restore. Same two refusals every
    // iSCSI mutation takes, for the same reason: this operation ends in a
    // `targetcli` enable, and enabling ends in `saveconfig` (GT-22).
    const state = await readIscsiState(executor, iscsiPaths)
    const notInstalled = assertInstalled(state.ctx)
    if (notInstalled) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: notInstalled.reason, message: notInstalled.message } }
    }
    const degraded = assertSaveable(state.ctx, state.targets)
    if (degraded) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: degraded.reason, message: degraded.message } }
    }

    // backup2.10: the second door. A `newLun` target restores the image AS A
    // NEW LUN and the source is never touched, so it pre-flights a different
    // set of facts (there is no source LUN to check) and runs a different job.
    // `confirmStore` arrives already narrowed — the 503 guard above ran first.
    if (req.target?.mode === 'newLun')
      return restoreNewLunImage(request, reply, req, state, confirmStore)

    // In-place: the shared schema made `lun` required when there is no newLun
    // target, so this is a type-level backstop, not an expected path.
    const lunRef = req.lun
    if (!lunRef) {
      reply.code(400)
      return {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'An in-place image restore names the LUN it writes back (lun); '
            + 'to restore as a NEW LUN send target with mode=newLun.',
        },
      }
    }

    // (2) The target and the LUN.
    const target = state.targets.find(t => t.iqn === lunRef.targetIqn)
    if (!target) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `iSCSI target '${lunRef.targetIqn}' not found` } }
    }
    if (target.ownership !== 'anas') {
      reply.code(409)
      return {
        error: {
          code: 'CONFLICT',
          reason: 'foreign-target',
          message: `Target '${target.iqn}' is not managed by ANAS and is hands-off: ${target.ownershipDetail}`,
        },
      }
    }
    const lun = target.luns.find(l => l.index === lunRef.index)
    if (!lun) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Target '${target.iqn}' has no LUN ${lunRef.index}` } }
    }

    // (3) The backing has to be a block object ANAS understands, and it has to
    // be present. A `foreign` backing is somebody else's storage; `unresolved`
    // is the boot-restore hole (iscsi.5) — writing an image at either would be
    // writing at a path ANAS cannot vouch for.
    if (lun.kind !== 'zvol' && lun.kind !== 'file') {
      reply.code(409)
      return {
        error: {
          code: 'CONFLICT',
          reason: 'backing-not-restorable',
          message: `LUN ${lun.index} of ${target.iqn} is backed by '${lun.backingPath}', which ANAS reports as `
            + `'${lun.kind}'. A whole-image restore writes directly at the backing object, so it is only offered `
            + 'for a ZFS volume or an image file ANAS can resolve.',
        },
      }
    }
    if (lun.backingExists === false) {
      reply.code(409)
      return {
        error: {
          code: 'CONFLICT',
          reason: 'backing-missing',
          message: `The backing object '${lun.backingPath}' does not resolve on this node right now, so there is `
            + 'nothing to restore onto. Bring the storage back (import the pool, restore the image file) and '
            + 'repair the LUN from the iSCSI screen first.',
        },
      }
    }

    // (3b) ident.2 (audit #10): the object at the path must be the one LIO
    // serves. After a rename + re-create under the live LUN the path names a
    // DIFFERENT volume than the initiator sees, and the image would land in it.
    const served = await checkServedDevice(state.ctx.live, lun, statDeviceFrom(iscsiPaths))
    if (served.refusal) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: served.refusal.reason, message: served.refusal.message } }
    }
    const bound = servedLunIdentity(target.iqn, lun, served.device)

    // (4) The snapshot, and the archive inside it — the FIRST PBS contact, and
    // it is backup2.5's own read. Not a second parser: the restore resolves the
    // manifest through exactly the call the picker used, so what is written back
    // is what the operator was shown. Only the ONE group the snapshot names is
    // listed (`snapshot list <group>`) — cheaper and more precise than listing
    // the namespace and filtering.
    //
    // `readDepsFor` has already answered every LOCAL fault (unknown repository,
    // no stored credential) with its own 4xx. A PBS-side outcome comes back as a
    // VERDICT, which a picker renders as a message — but a restore cannot
    // proceed on one, so here it becomes a refusal that quotes it.
    const deps = await readDepsFor(req.repo, reply, req.ns?.trim() || undefined)
    if (!deps)
      return reply
    const group = snapshotGroup(req.snapshot)
    const listed = await listSnapshots(executor, deps, group)
    if (!listed.ok) {
      const notFound = listed.verdict === 'not-found'
      reply.code(notFound ? 404 : 502)
      return {
        error: {
          code: notFound ? 'NOT_FOUND' : 'UPSTREAM_ERROR',
          reason: listed.verdict,
          message: `Could not read '${group}' in repository '${req.repo}': ${listed.detail}`,
        },
      }
    }
    const entry = listed.data.find(s => s.snapshot === req.snapshot)
    if (!entry) {
      reply.code(404)
      return {
        error: {
          code: 'NOT_FOUND',
          message: `Snapshot '${req.snapshot}' is not in repository '${req.repo}'`
            + `${deps.namespace ? ` namespace '${deps.namespace}'` : ''}.`,
        },
      }
    }
    const imageSize = imageArchiveSize(entry, req.archive)

    // (5) THE size check. GT-42: nothing below ANAS does this, and the failure
    // it prevents is silent and destructive in BOTH directions.
    const targetSize = await readTargetSize(executor, lun)
    if ('error' in targetSize) {
      reply.code(409)
      return {
        error: {
          code: 'CONFLICT',
          reason: 'target-size-unknown',
          message: `${targetSize.error}. A whole-image restore is refused when the target's exact size cannot `
            + 'be read: the size equality is the only thing standing between this operation and a '
            + 'half-overwritten LUN.',
        },
      }
    }
    const mismatch = assertSizeMatch(imageSize, targetSize.size, {
      archive: req.archive,
      targetPath: lun.backingPath,
    })
    if (mismatch) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: 'size-mismatch', message: mismatch } }
    }

    // (6) The entry gate: a live session is a hard 409 with no bypass. There is
    // no confirmation that makes overwriting a block device an initiator has
    // open and mounted safe from this side.
    //
    // This is the FIRST of two askings. The state above was read when the
    // request arrived; the job it submits may not run for hours (the queue runs
    // four at a time and a restore can queue behind long backups), so
    // `runImageRestore` asks again under the iSCSI lock immediately before it
    // disables anything — with the same sentence, from the same helper.
    if (target.sessions.length > 0) {
      reply.code(409)
      return {
        error: {
          code: 'CONFLICT',
          reason: 'live-sessions',
          message: liveSessionsRefusal(target.iqn, target.sessions),
        },
      }
    }

    // (7) The confirm gate. Everything above is a refusal; this is the one
    // choice the operator is allowed to make, and the warnings say exactly what
    // it costs.
    const otherLuns = target.luns.filter(l => l.index !== lun.index).length
    // ident.2 (audit #10): the code binds the LUN's SERIAL and the exact
    // snapshot + archive, never the index — a LUN re-created at the index, or
    // a different point in time picked inside the TTL, mints a new challenge.
    // cr.56 (folded from cr.54, review H3's last line): and the EFFECTIVE
    // namespace — a snapshot is named within its namespace, so the same name
    // in another one is another point in time. Signed through `guardConfirm`
    // (request fields only; this door is not on a guard spec): a resend with
    // another namespace, snapshot, archive or repository is 409
    // CONFIRM_SCOPE_CHANGED naming the field, while another LUN (target or
    // serial — the address) is a fresh challenge, as before.
    if (!guardConfirm(confirmStore, request, reply, imageRestoreConfirmSpec(`LUN ${lun.index} of ${target.iqn}`), CONFIRM_ONLY_PASS, {
      validated: { target: target.iqn, serial: lun.serial, repo: req.repo, ns: deps.namespace ?? null, snapshot: req.snapshot, archive: req.archive },
      address: ['target', 'serial'],
      message: `Restoring ${req.archive} from ${req.snapshot} over LUN ${lun.index} of ${target.iqn}`,
      warnings: [
        `This OVERWRITES ${lun.backingPath} completely — every byte currently on LUN ${lun.index} is replaced `
        + `by the ${imageSize} bytes in the backup, and there is no undo.`,
        `The WHOLE TARGET goes offline for the duration, not just this LUN: LIO's enable flag lives on the `
        + `target portal group${otherLuns > 0 ? `, so its other ${otherLuns} LUN${otherLuns === 1 ? '' : 's'} are unreachable too` : ''}.`,
        'Disabling refuses new logins and hides the target from discovery, so an initiator that auto-reconnects '
        + '(open-iscsi, Windows) cannot come back mid-restore. It is re-enabled when the restore finishes.',
        'If the restore fails part-way, the LUN holds a HALF-WRITTEN image and the target stays disabled until '
        + 'you restore again or explicitly enable it.',
      ],
    })) {
      return reply
    }

    // Disk space is NOT a consideration here, for either backing kind: the
    // image is streamed in place over an object that is already exactly its
    // size (that is what the equality check just proved), so nothing new is
    // allocated. A sparse zvol or a sparse image file may of course consume
    // more of its pool as the holes fill — that is a pool-capacity question,
    // not a restore pre-flight one.
    // The repo as the route read it (the snapshot's list and size came from
    // it); the job reads it and its secret again when it starts (cr.56,
    // `restoreDepsNow`), and neither ever leaves this scope.
    const { repo } = deps

    // cr.64a (item 2): the backing's keys beside the target's and the LUN's —
    // the LUN verbs' one builder (cr.63 L17), in its SHARED mode: an in-place
    // restore rewrites the backing object's bytes and changes nothing about
    // the volume or the filesystem underneath, exactly like a LUN add. A
    // dataset or pool verb that DESTROYS, renames or rolls back that backing,
    // or unmounts its filesystem (all exclusive on these keys) now waits for
    // the restore and re-gates after it — before, it could `zfs destroy` the
    // object the image was streaming into. The guid fallback and the
    // movers' path resolution are `lunBackingClaims'` own (cr.63's rule).
    const backingKeys = await lunBackingClaims(executor, lun, 'shared')

    // The journald audit params: what was restored, from where, onto which LUN.
    // No secret and no repository credential ever rides here.
    //
    // The queue reads this object again when the job FINISHES, so the one fact
    // that is not knowable at submit time — how many bytes actually reached the
    // device — is filled in by the handler below and lands on the completion
    // line. `imageBytes` is what the manifest promised; `bytesWritten` is what
    // happened. A FAILED restore has no result to read it from — there the
    // count rides the error message ("the image was partially written (N of M
    // bytes reached …)"), which the audit line carries verbatim.
    const auditParams: Record<string, unknown> = {
      repo: repo.name,
      ...(deps.namespace ? { namespace: deps.namespace } : {}),
      snapshot: req.snapshot,
      archive: req.archive,
      target: target.iqn,
      lun: lun.index,
      backing: lun.backingPath,
      imageBytes: imageSize as number,
    }

    const job = jobQueue.submit(
      'backup.restore.image',
      { ...identity, params: auditParams },
      // NO `withIscsiLock` here: `runImageRestore` OWNS the lock for this
      // operation and takes it twice — once for the session re-check plus the
      // disable, once for the re-enable — leaving it released across the image
      // stream, which can run for hours. Wrapping the call would both hold the
      // node's only iSCSI mutex for that whole time and deadlock against the
      // service's own acquisition (the mutex is a plain chain, not reentrant).
      async updateProgress => runImageRestore(
        executor,
        {
          ...(await restoreDepsNow(req.repo, repo).then(now => ({ ...now, env: buildBackupEnv(now.repo, now.secret) }))),
          ...(deps.namespace ? { namespace: deps.namespace } : {}),
          snapshot: req.snapshot,
          archive: req.archive,
          imageSize: imageSize as number,
          target,
          lun,
          ...(req.rate ? { rate: req.rate } : {}),
          readBack: async () => (await readIscsiState(executor, iscsiPaths)).targets,
          // The run-time answer to the question the entry gate asked at the
          // request. A target that has VANISHED in the meantime reports no
          // sessions — the disable that follows is what discovers that, and it
          // fails loudly with targetcli's own words rather than this read
          // inventing a second story about it.
          readSessions: async (iqn) => {
            const now = await readIscsiState(executor, iscsiPaths)
            return now.targets.find(t => t.iqn === iqn)?.sessions ?? []
          },
          // ident.2: called under the lock by runImageRestore — same serial,
          // backstore, path and served device (throws otherwise), and the
          // backing object's size as read NOW.
          //
          // cr.40: and the route's pre-flight gates (1)-(2), asked of the same
          // read — LIO installed and not degraded (the disable and the
          // re-enable each end in saveconfig, GT-22), the target still ANAS's.
          // The returned target is the fresh one: its `enabled` decides the
          // disable.
          reverify: async () => {
            const fresh = await reverifyServedLun(executor, iscsiPaths, bound, { requireDevice: true })
            const freshState = { ctx: fresh.ctx, targets: fresh.targets }
            for (const gate of [saveableGate, foreignGate]) {
              const refused = await gate({ state: freshState, target: fresh.target }, new GuardReads())
              if (refused)
                throw new GuardRefusalError(refused)
            }
            const size = await readTargetSize(executor, fresh.lun)
            return { target: fresh.target, lun: fresh.lun, size: 'error' in size ? null : size.size }
          },
          mutate: {
            executor,
            configfsRoot: iscsiPaths.configfsRoot ?? CONFIGFS_TARGET_ROOT,
            progress: updateProgress,
          },
        },
        updateProgress,
      ).then((result) => {
        auditParams.bytesWritten = result.bytesWritten
        return result
      }),
      // cr.33 (§4.3): a restore is a data mover — the long lane. cr.40: it
      // holds the target's key and the LUN's for the run — the whole target
      // is disabled while the image streams. cr.64a: and the backing's keys,
      // shared, for the same duration.
      { lane: 'long', locks: [...lunClaims(target.iqn, lun.serial), ...backingKeys] },
    )

    reply.code(202)
    return { job }
  }

  // --- The restore-as-a-NEW-LUN branch (story backup2.10; guard: cr.54) ----
  //
  // Its own pre-flight, because it checks different facts: there is NO source
  // LUN to look up, NO size equality to prove (the new backing is created at
  // exactly the image's size, so a mismatch is impossible by construction),
  // NO live-session gate (nothing existing goes offline) and NO TPG disable.
  // What it does check, in order — every refusal before anything destructive:
  //
  //   1. LIO installed, not degraded                          (shared, above)
  //   2. the target exists and is ANAS-owned
  //   3. the name is free — the backstore name is NODE-GLOBAL (GT-15)
  //   4. the backing storage resolves onto ANAS-managed storage
  //   5. the snapshot exists and the manifest knows the image's size
  //   6. the confirm gate (409 + X-Anas-Confirm-Code)
  //
  // cr.54 (review H3, ruling (j)): 1–4 are the gates of ONE guard spec — the
  // add-LUN door's (iscsi-mutate.ts), with the restore's backing resolver —
  // run at the request, again when the queue starts the job, and again under
  // the iSCSI lock right before the map; the resolved backing PATH is bound
  // by the confirm and re-compared by a gate, so a dataset whose mountpoint
  // moved while the job waited fails it STATE_CHANGED instead of writing an
  // image somewhere else. 5 is a
  // fact about the immutable PBS snapshot the confirm signs by name. The
  // confirm signs the whole validated request: target, name, backing (kind
  // and pool/dataset), repository, namespace, snapshot, archive, rate.
  //
  // Only then is a job submitted, and only inside that job does anything change.
  async function restoreNewLunImage(
    request: FastifyRequest,
    reply: FastifyReply,
    req: BackupImageRestoreRequest,
    state: { ctx: IscsiReadContext, targets: IscsiTargetDetail[] },
    confirmStore: ConfirmStore,
  ) {
    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const newLun = req.target
    if (!newLun || newLun.mode !== 'newLun')
      return reply
    const iqn = newLun.targetIqn
    const guardDeps = { executor, paths: iscsiPaths }

    // (4) The backing storage — resolved exactly the way the add-LUN door
    // resolves it, because a restore's new backing is one of its two kinds:
    // a zvol is the pool's volume named after the LUN, a file is the image
    // `<dir>/<name>.raw` on a dataset or an AHR pool. Everything not
    // ANAS-managed is refused by the same helper, with its own wording. Read
    // once per guard run: the gate, the scope, the locks and the job body
    // share it.
    const backingOf = (o: TargetObject, reads: GuardReads): Promise<{ ok: NewLunBacking } | { refusal: BackingRefusal }> =>
      reads.once('restore:new-lun:backing', async () => {
        if (newLun.backing.kind === 'zvol') {
          const resolved = resolveZvolBacking(`${newLun.backing.pool}/${newLun.name}`, o.state.ctx)
          return 'refusal' in resolved ? { refusal: resolved.refusal } : { ok: { backing: resolved.ok } }
        }
        const dir = await resolveFileBackingDir(executor, newLun.backing.dataset ?? newLun.backing.ahrPool ?? '', o.state.ctx)
        if ('refusal' in dir)
          return { refusal: dir.refusal }
        return {
          ok: {
            backing: {
              path: imageFilePath(dir.ok.dir, newLun.name),
              plugin: 'fileio',
              ...(dir.ok.dataset ? { dataset: dir.ok.dataset } : {}),
            },
            dir: dir.ok.dir,
            ...(dir.ok.ahr ? { ahr: dir.ok.ahr } : {}),
          },
        }
      })
    let routeBacking: NewLunBacking | undefined
    const backingGate: Gate<TargetObject> = async (o, reads) => {
      const b = await backingOf(o, reads)
      if ('refusal' in b)
        return conflict(b.refusal)
      // The route door's run is the first; its answer is what the confirm shows.
      routeBacking ??= b.ok
      return null
    }
    // The backing PATH the operator was shown (and the confirm signed) is
    // where the image goes. A dataset whose mountpoint moved while the job
    // waited resolves elsewhere: that is no refusal of the backing itself
    // (the gate above passed), it is a different restore than the one
    // confirmed. At the route this compares the run with itself.
    const backingUnmovedGate: Gate<TargetObject> = async (o, reads) => {
      const b = await backingOf(o, reads)
      if ('refusal' in b || !routeBacking || b.ok.backing.path === routeBacking.backing.path)
        return null
      return {
        status: 409,
        code: 'STATE_CHANGED',
        message: `The new LUN's backing changed since you confirmed (was: ${routeBacking.backing.path}; `
          + `now: ${b.ok.backing.path}) — nothing was done; confirm again`,
      }
    }

    const spec: GuardSpec<TargetObject> = {
      operation: 'backup.restore.image',
      // No revision: like an add, the restore is placed into whatever the
      // target is when it runs (the index and the grants are read under the
      // lock at the map). The backing path is bound by the confirm
      // (`confirmScope`) and compared by the job through its own gate, so a
      // backing the job's re-run REFUSES answers with the refusal's sentence.
      object: targetView(guardDeps, iqn, {
        seed: state,
        revision: false,
        scopeLabels: { backing: 'the new LUN\'s backing' },
      }),
      // (2) target there and ANAS's, (3) the name free node-wide, (4) the
      // backing resolves onto ANAS storage — at the path that was confirmed.
      gates: [saveableGate, foreignGate, lunNameFreeGate(newLun.name), backingGate, backingUnmovedGate],
      // §4.2: the target's key (the LUN set and the grants change) and the
      // keys the sibling verb that creates this backing takes — a zvol is a
      // dataset CREATE (its own key exclusive, every ancestor and the pool
      // shared, as `zfs.create`); an image file lands on a filesystem a data
      // mover writes into (`pathSourceClaims` of its directory, shared). All
      // of them go back at the map (`mapped` → `ctx.release()`): from there on
      // the LUN holds its backing, and every destroy refuses a held backing.
      locks: async (o, _bound, reads) => {
        const claims = [iscsiTargetClaim(iqn)]
        const b = await backingOf(o, reads)
        if ('refusal' in b)
          return claims
        if (newLun.backing.kind === 'zvol') {
          const pool = newLun.backing.pool
          const guid = await readPoolGuid(executor, pool).catch(() => null)
          claims.push(...zfsDatasetClaims(guid?.guid, b.ok.backing.dataset ?? `${pool}/${newLun.name}`, 'exclusive'))
        }
        else if (b.ok.dir) {
          claims.push(...(await pathSourceClaims(executor, [b.ok.dir], readAhrPools)).claims)
        }
        return claims
      },
      // cr.64a: when the guard's job-time recompute finds the job needs keys
      // the route was never granted, say what moved in the operator's own
      // terms — the backing. (The unmoved gate above usually answers first;
      // this is the sentence for a backing that still RESOLVES but whose
      // filesystem keys moved.)
      locksMoved: async (o, reads) => {
        const b = await backingOf(o, reads)
        if ('refusal' in b || !routeBacking)
          return 'the new LUN\'s backing changed'
        return routeBacking.backing.path === b.ok.backing.path
          ? `the new LUN's backing ${b.ok.backing.path} now lives on a different filesystem`
          : `the new LUN's backing was ${routeBacking.backing.path}; now ${b.ok.backing.path}`
      },
    }

    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const target = pre.object.target
    const { backing } = routeBacking as NewLunBacking

    // (5) The snapshot, and the manifest's size of the image inside it — the
    // FIRST PBS contact, through the same read as the picker (backup2.5). The
    // size is not an equality to prove here: the new backing is CREATED at
    // exactly that size. What it must be is KNOWN — a restore without the
    // manifest's number would be a LUN whose end nobody checked.
    const deps = await readDepsFor(req.repo, reply, req.ns?.trim() || undefined)
    if (!deps)
      return reply
    const group = snapshotGroup(req.snapshot)
    const listed = await listSnapshots(executor, deps, group)
    if (!listed.ok) {
      const notFound = listed.verdict === 'not-found'
      reply.code(notFound ? 404 : 502)
      return {
        error: {
          code: notFound ? 'NOT_FOUND' : 'UPSTREAM_ERROR',
          reason: listed.verdict,
          message: `Could not read '${group}' in repository '${req.repo}': ${listed.detail}`,
        },
      }
    }
    const entry = listed.data.find(s => s.snapshot === req.snapshot)
    if (!entry) {
      reply.code(404)
      return {
        error: {
          code: 'NOT_FOUND',
          message: `Snapshot '${req.snapshot}' is not in repository '${req.repo}'`
            + `${deps.namespace ? ` namespace '${deps.namespace}'` : ''}.`,
        },
      }
    }
    const imageSize = imageArchiveSize(entry, req.archive)
    if (imageSize === null) {
      reply.code(409)
      return {
        error: {
          code: 'CONFLICT',
          reason: 'image-size-unknown',
          message: `The size of archive '${req.archive}' is not in the snapshot manifest, so ANAS cannot `
            + `create the new backing at the image's exact size. A whole-image restore is refused without `
            + 'that proof: a backing of the wrong size would be a LUN whose end does not match the image it holds.',
        },
      }
    }

    // (6) The confirm gate. The warnings say exactly what this is and is not:
    // a NEW disk, nothing existing touched, the source stays where it is.
    // cr.54: the code signs the whole validated request and the backing path —
    // a resend with another archive, snapshot, namespace or backing is 409
    // CONFIRM_SCOPE_CHANGED naming the field.
    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: {
        target: iqn,
        mode: 'newLun',
        name: newLun.name,
        backing: newLun.backing,
        repo: req.repo,
        ns: deps.namespace ?? null,
        snapshot: req.snapshot,
        archive: req.archive,
        rate: req.rate ?? null,
      },
      address: ['target'],
      confirmScope: { backing: backing.path },
      message: `Restoring ${req.archive} from ${req.snapshot} as a NEW LUN '${newLun.name}' on ${target.iqn}`,
      warnings: [
        `This creates a NEW LUN '${newLun.name}' backed by ${backing.path} at exactly the image's size `
        + `(${imageSize} bytes), mapped at the next free index on ${target.iqn}. Nothing that exists is touched.`,
        'The new LUN gets a FRESH unit serial: a restored copy is a NEW disk, so an initiator that identified '
        + 'the original by its serial will see a different disk.',
        'The source LUN — the LUN this image was backed up from — is not touched: it stays online, keeps its '
        + 'serial, and no initiator has to log out.',
        'If the restore fails part-way, ANAS removes the new LUN, its backstore and its backing — nothing of '
        + 'the failed attempt is left behind, and the half-written state is never persisted.',
      ],
    })) {
      return reply
    }

    // The repo as the route read it; the job reads it and its secret again
    // when it starts (cr.56, `restoreDepsNow`).
    const { repo } = deps

    // The journald audit params — the queue's completion line carries them, with
    // `bytesWritten` filled in when the job finishes, exactly as the in-place
    // restore does. No secret and no repository credential ever ride here.
    const auditParams: Record<string, unknown> = {
      repo: repo.name,
      ...(deps.namespace ? { namespace: deps.namespace } : {}),
      snapshot: req.snapshot,
      archive: req.archive,
      target: target.iqn,
      lun: newLun.name,
      backing: backing.path,
      imageBytes: imageSize,
      mode: 'newLun',
    }

    const job = jobQueue.submit(
      'backup.restore.image',
      { ...identity, params: auditParams },
      // NO `withIscsiLock` here: `runNewLunImageRestore` OWNS the lock for this
      // operation and takes it only for its short targetcli sections (create+map
      // the LUN, the final saveconfig, and any cleanup undo), leaving it released
      // across the image stream, which can run for hours. Wrapping the call would
      // both hold the node's only iSCSI mutex for that whole time and deadlock
      // against the service's own acquisitions (the mutex is a plain chain, not
      // reentrant) — the same fix #52 applied to the in-place door.
      //
      // cr.54: the job door (`guarded`) re-reads the target and re-runs every
      // gate above — the backing resolution included — before the body; the
      // body acts on the backing as THIS run resolved it (the unmoved gate
      // proved its path unchanged).
      guarded(spec, pre, async (now, ctx) => {
        const fresh = await backingOf(now, ctx.reads)
        // Unreachable: the job door's backing gate resolved the SAME memoised
        // read and would have thrown its refusal; kept as the type-narrower,
        // throwing the gate's own refusal if the memo invariant ever breaks.
        if ('refusal' in fresh)
          throw new GuardRefusalError(conflict(fresh.refusal))
        // The job door just re-proved the target; the service's own step-0
        // re-read takes that answer, and its re-read under the lock before
        // the map runs the whole spec again (the id and every gate).
        let proved: IscsiTargetDetail | undefined = now.target
        const depsNow = await restoreDepsNow(req.repo, repo)
        return runNewLunImageRestore(
          executor,
          {
            repo: depsNow.repo,
            secret: depsNow.secret,
            ...(deps.namespace ? { namespace: deps.namespace } : {}),
            snapshot: req.snapshot,
            archive: req.archive,
            imageSize,
            target: now.target,
            // cr.40 (audit #34): the destination re-read in the job, with the
            // route's own gates — the index and the grants come from this read.
            refresh: async () => {
              if (proved) {
                const first = proved
                proved = undefined
                return first
              }
              return (await reverify(spec, pre.bound)).object.target
            },
            name: newLun.name,
            backing: fresh.ok.backing,
            ...(fresh.ok.ahr ? { ahr: { fstabPath, pool: fresh.ok.ahr } } : {}),
            ...(req.rate ? { rate: req.rate } : {}),
            env: buildBackupEnv(depsNow.repo, depsNow.secret),
            mutate: {
              executor,
              configfsRoot: iscsiPaths.configfsRoot ?? CONFIGFS_TARGET_ROOT,
              progress: ctx.updateProgress,
            },
            // cr.38: the keys go back the moment the LUN is mapped, and are
            // taken again before a failed run's undo unmaps it.
            mapped: ctx.release,
            beforeUndo: ctx.reacquire,
          },
          ctx.updateProgress,
        ).then((result) => {
          auditParams.bytesWritten = result.bytesWritten
          return result
        })
      }),
      // cr.33 (§4.3): a restore is a data mover — the long lane. cr.38 session
      // B (cr.40's intent): it holds the target's key (`iscsi-target:<iqn>`)
      // from its re-read of the target until the LUN is MAPPED — the index and
      // the ACL grants it maps with are read under it — and gives it back for
      // the image stream (`mapped`), so a verb on a target that stays online
      // (adding an ACL, deleting another LUN) waits only until the map, never
      // for the hours the image takes. A failed run takes the key again before
      // its undo unmaps the LUN (`beforeUndo`). cr.54: plus the new backing's
      // own keys (the spec's `locks`), on the same release/reacquire.
      { lane: 'long', locks: pre.locks },
    )

    reply.code(202)
    return { job }
  }

  // --- The SELECTIVE FILE branch (story backup2.6; on the guard since cr.54) -
  //
  // The pre-flight order below is an order, not a set: every refusal happens
  // before the client is called at all, and the cheapest, most local checks
  // come first. Each one exists because the client fails LATE, DESTRUCTIVELY
  // or SILENTLY without it:
  //
  //   1. whose storage is this?  PVE territory (a storage.cfg that cannot be
  //      read REFUSES — cr.54), and a live LUN's backing
  //   2. a newLocation path that exists and is NOT a directory is refused
  //   3. what IS the selection?  hardlink groups completed, trees identified,
  //      file sizes read — ONE catalog-shell session                 <- GT-25/24
  //   4. can we write there?     a read-only target fails at the FIRST file
  //                                                                  <- GT-56 F8
  //   5. does it fit?            ENOSPC leaves a half-written tree
  //   6. the confirm gate, for a MERGE into an existing newLocation directory
  //      or an IN-PLACE restore of a TREE, and nothing else
  //
  // cr.54 (review H3, ruling (j)): 1–5 are the gates of ONE guard spec, run at
  // the request and again in the job when the queue starts it — the long lane
  // can hold a restore for hours behind other data movers, and every one of
  // them is a fact about a destination that may have changed meanwhile. The
  // confirm signs the whole validated request (destination, mode, repository,
  // namespace, snapshot, archive, every selection, the options) plus the
  // destination's revision: what kind of thing is at the path and which
  // filesystem it is on. The job holds the destination's `zfs:`/`ahr:`/`mount:`
  // keys SHARED (the data movers' `pathSourceClaims`), so a destroy, rollback
  // or unmount of the filesystem it writes into waits for it, and one accepted
  // before it ran is seen by its re-read.
  //
  // Only then is a job submitted, and only inside that job does anything change.
  async function restoreFiles(
    request: FastifyRequest,
    reply: FastifyReply,
    req: BackupFilesRestoreRequest,
  ): Promise<unknown> {
    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!confirmStore) {
      reply.code(503)
      return {
        error: {
          code: 'UNAVAILABLE',
          message: 'The confirmation store is not configured, so an in-place restore cannot be gated. '
            + 'Restore is refused rather than run unguarded.',
        },
      }
    }

    // A block image has no inside to select from — `catalog shell` answers
    // `Can only mount pxar archives.` — so it is refused here by NAME, before
    // any contact, and pointed at its own door.
    const { kind: archiveKind } = classifyArchiveFile(req.archive)
    if (archiveKind !== 'pxar') {
      reply.code(400)
      return {
        error: {
          code: 'VALIDATION_ERROR',
          message: `'${req.archive}' is not a file archive - a block image is restored whole, from the LUN it backs, `
            + 'not by picking files out of it.',
        },
      }
    }

    const deps = await readDepsFor(req.repo, reply, req.ns?.trim() || undefined)
    if (!deps)
      return

    // --- Where does it land? -------------------------------------------------
    // The HOME is the archive's live directory: the caller's `path` when it
    // sent one, else the task archive of this name. An expanded archive
    // (backup2.3's `<name>__<child>`) matches no stored archive on purpose —
    // its name flattened a path and cannot be inverted — so the caller names
    // the directory and ANAS guesses nothing. Nothing here creates a dataset.
    //
    // `newLocation` (backup2.10) is the exception to "home": its `path` IS the
    // destination directory, not the archive's live home — the schema made it
    // required for that mode, so the task lookup below never runs for it.
    const mode = req.target.mode
    let home = req.target.path
    if (!home && mode !== 'newLocation' && req.task) {
      const task = await readTask(systemdDir, req.task)
      home = task?.archives.find(a => a.name === bareArchiveName(req.archive))?.path
    }
    if (!home) {
      reply.code(400)
      return {
        error: {
          code: 'VALIDATION_ERROR',
          message: `Name the directory to restore into (target.path): archive '${req.archive}' does not match an archive of a task on this node.`,
        },
      }
    }

    // cr.36r: the destination is canonicalised ONCE here with the normaliser
    // the mount routes use (mirroring 0ef1284e), so the PVE-territory check,
    // the held-by-LUN claim, the path probe, the confirm signature and the
    // write all see one spelling — `/mnt//pve/x` is `/mnt/pve/x` and cannot
    // slip past the territory refusal on a trailing-slash-only strip.
    const target = normalizeMountpointPath(home)

    // cr.56 (folded from cr.54's report): the repository and its secret per
    // guard RUN — the route's run uses what `readDepsFor` just read; the job's
    // runs (its gates contact PBS too: the catalog shell, the snapshot size)
    // read them fresh through `restoreDepsNow`, as the backup run does, so a
    // token rotated while the restore waited is the one every job-time pbc
    // call carries. The confirm signed the route's effective namespace, which
    // stays.
    let routeRun = true
    const depsOf = (reads: GuardReads): Promise<typeof deps> => reads.once('restore:deps', async () =>
      routeRun ? deps : { ...deps, ...(await restoreDepsNow(req.repo, deps.repo)) })

    /**
     * The destination as ONE guard run reads it. Every fact is lazy and read
     * once per run through that run's {@link GuardReads}, so a refusal early in
     * the gate list never pays for the later reads (a path under /mnt/pve is
     * refused before anything stats it), and the route's run and the job's
     * never share a fact.
     */
    const readDestination = (reads: GuardReads): RestoreDestination => {
      // What is at the path: 'directory', another kind, or null (absent — or a
      // probe that could not finish; the write test then asks again).
      const kind = (): Promise<string | null> => reads.once('restore:kind', () => pathKind(executor, target))
      // In place is ALWAYS a merge; a newLocation merges only into a directory
      // that already exists — the shape that earns the confirm.
      const merge = async (): Promise<boolean> => mode === 'inPlace' || (await kind()) === 'directory'
      // A newLocation directory that does NOT exist yet is created by the
      // client, so the write and space probes go where it will be created.
      const writeDir = async (): Promise<string> => (await merge()) ? target : parentDirectory(target)
      const selection = (): Promise<SelectionFacts> => reads.once('restore:selection', async () =>
        readSelectionFacts(executor, { ...(await depsOf(reads)), snapshot: req.snapshot, archive: req.archive, path: '/' }, req.selections))
      // The exact sum of the picked files when every selection is a file, else
      // the manifest's logical archive size (GT-4) — an upper bound, and the
      // refusal says which figure it used.
      const space = (): Promise<{ refusal: string | null, warnings: string[] }> => reads.once('restore:space', async () => {
        const facts = await selection()
        const warnings = [...facts.warnings]
        let archiveBytes: number | null = null
        const group = groupOfSnapshotId(req.snapshot)
        if (facts.exactBytes === null && group) {
          const listing = await listSnapshots(executor, await depsOf(reads), group)
          if (listing.ok) {
            const snap = listing.data.find(s => s.snapshot === req.snapshot)
            const file = snap?.files.find(f => f.archive === req.archive)
            archiveBytes = typeof file?.size === 'number' ? file.size : null
          }
          if (archiveBytes === null)
            warnings.push('The archive size could not be read, so the restore ran without a space check.')
        }
        const dir = await writeDir()
        const available = await availableBytes(executor, dir)
        const estimate = estimateSpace(facts.exactBytes ?? archiveBytes, facts.exactBytes !== null, available, dir)
        return { refusal: estimate.refuse ? `Not enough free space for this restore. ${estimate.detail}` : null, warnings }
      })
      // The filesystem the destination is on, as the lock keys name it.
      const claims = (): Promise<SourceClaims> => reads.once('restore:claims', () => pathSourceClaims(executor, [target], readAhrPools))
      return { target, kind, merge, writeDir, selection, space, claims }
    }

    // --- The gates: each one function, run by both doors ---------------------

    // (1) PVE's territory is read-only and hands-off, always — no override. An
    // unreadable storage.cfg is not "no storages": it refuses (cr.54).
    const territoryGate: Gate<RestoreDestination> = async (o, reads) => {
      const pvePaths = await reads.once('restore:pve-paths', () => readPveMountPathsStrict(paths.pveStorageCfg))
      return restoreTerritoryRefusal(o.target, pvePaths, paths.pveStorageCfg)
    }
    // (1b) A live iSCSI LUN's backing object is a block device somebody else
    // has open. `heldByLun` is the ONE question iscsi.6 established for exactly
    // this — it catches the backing path itself AND any directory that CONTAINS
    // one, which is the real hazard here: a file-backed LUN is an ordinary
    // file, so an in-place `--overwrite` restore into its directory would
    // rewrite it silently while initiators are mid-write. Fail-open: no LIO,
    // nothing held.
    const heldGate: Gate<RestoreDestination> = async (o) => {
      const held = await heldByLun(createIscsiClaimCache(executor, iscsiPaths), { path: o.target })
      if (!held)
        return null
      const refusal = heldByLunRefusal(`'${o.target}'`, 'Restoring files into', held)
      return { status: 409, code: 'CONFLICT', reason: refusal.reason, message: refusal.message }
    }
    // (2) A newLocation into a path that exists and is NOT a directory: there
    // is nothing to merge into. (One that IS a directory is the operator's
    // choice — ruling 2026-08-29 — and earns the confirm below.)
    const kindGate: Gate<RestoreDestination> = async (o) => {
      if (mode !== 'newLocation')
        return null
      const kind = await o.kind()
      if (kind === null || kind === 'directory')
        return null
      return {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: `'${o.target}' already exists and is not a directory - a restore needs a directory. Remove it or choose another path.`,
      }
    }
    // (3) One catalog-shell session: hardlink groups completed (a partly-named
    // group fails the whole job), directories identified (the confirm's only
    // in-place trigger), file sizes read (the exact space figure).
    const selectionGate: Gate<RestoreDestination> = async (o) => {
      const facts = await o.selection()
      if (!facts.unknown.length)
        return null
      return {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: `This snapshot's '${req.archive}' does not hold ${facts.unknown.join(', ')} - `
          + 'the client would report success and restore nothing for those, so the restore is refused instead.',
      }
    }
    // (4) A read-only or dead target does not fail at the start: the client
    // enters the directory happily and dies at the FIRST FILE.
    const writableGate: Gate<RestoreDestination> = async (o) => {
      const writable = await writeTestDirectory(executor, await o.writeDir())
      return writable.ok ? null : { status: 409, code: 'CONFLICT', message: writable.detail }
    }
    // (5) ENOSPC leaves a half-written tree.
    const spaceGate: Gate<RestoreDestination> = async (o) => {
      const { refusal } = await o.space()
      return refusal ? { status: 409, code: 'CONFLICT', message: refusal } : null
    }

    const what = `Restore destination '${target}'`
    const spec: GuardSpec<RestoreDestination> = {
      operation: 'backup.restore.files',
      object: {
        what,
        read: async reads => readDestination(reads),
        id: async o => ({ path: o.target }),
        // Same destination STATE? What is at the path (a newLocation directory
        // created while the job waited would turn a fresh restore into an
        // unconfirmed merge) and the filesystem it is on (a dataset unmounted
        // or destroyed meanwhile leaves the path on its parent's).
        revision: async o => restoreDestinationRevision(await o.kind(), (await o.claims()).claims),
        unbound: () => `Could not read ${what} — refusing a restore that cannot be bound to it`,
      },
      gates: [territoryGate, heldGate, kindGate, selectionGate, writableGate, spaceGate],
      locks: async o => (await o.claims()).claims,
    }

    const pre = await guardCheck(spec)
    routeRun = false
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const merge = await pre.object.merge()
    const facts = await pre.object.selection()

    // --- (6) The confirm gate, and ONLY for two shapes -----------------------
    // A MERGE into a newLocation directory that EXISTS overwrites live data
    // with the same shape as in-place, so it earns the same 409 +
    // X-Anas-Confirm-Code (ruling 2026-08-29: no "refuse, pick another path";
    // a merge into a known directory is legitimate). An in-place restore of a
    // TREE is the one shape that can rewrite an unbounded amount of live data.
    // A single explicitly picked file restored in place is NOT gated: the
    // operator pointed at that file and ticked the in-place box, and that IS
    // the consent. A newLocation restore into a directory the restore will
    // CREATE is never gated — it writes only into a directory that did not
    // exist a moment ago (and the job refuses STATE_CHANGED if one appears).
    //
    // cr.54: the code signs the WHOLE validated request — a resend with
    // another archive, another selection or another option is 409
    // CONFIRM_SCOPE_CHANGED naming the field — and the destination's revision.
    let confirm: { message: string, warnings: string[] } | null = null
    if (mode === 'newLocation' && merge) {
      // The plain confirm dialog renders the warnings, not the error message —
      // so the one sentence rides in BOTH, said identically.
      const message = `'${target}' already exists: restoring into it overwrites files with the same names and keeps everything else. Confirm to proceed.`
      confirm = { message, warnings: [message] }
    }
    else if (mode === 'inPlace' && facts.hasDirectory) {
      confirm = {
        message: `Restore a directory from ${req.snapshot} INTO '${target}', over the live data`,
        warnings: [
          `Files in the snapshot will replace the ones in '${target}' that have the same names.`,
          'This is a MERGE, never a sync: anything under the target that is not in the archive is left exactly as it is.',
          'A directory selection restores the whole tree below it.',
        ],
      }
    }
    if (confirm && !guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: {
        target,
        mode,
        repo: req.repo,
        ns: deps.namespace ?? null,
        task: req.task ?? null,
        snapshot: req.snapshot,
        archive: req.archive,
        selections: req.selections,
        options: req.options,
        rate: req.rate ?? null,
      },
      address: ['target'],
      ...confirm,
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'backup.restore.files',
      {
        ...identity,
        params: {
          ...(req.task ? { task: req.task } : {}),
          repo: deps.repo.name,
          ...(deps.namespace ? { namespace: deps.namespace } : {}),
          snapshot: req.snapshot,
          archive: req.archive,
          selections: facts.selections.length,
          target,
          mode,
          merge,
        },
      },
      // The job door: every gate above runs again against facts read NOW —
      // and the selection, the merge decision and the space warnings the
      // restore acts on are the job's own reads, never the request's.
      guarded(spec, pre, async (now, ctx) => {
        const unlocked = unlockedSourcesLine((await now.claims()).unlocked)
        if (unlocked)
          ctx.updateProgress(`restore into '${target}': ${unlocked}`)
        const fresh = await now.selection()
        const { warnings } = await now.space()
        const mergeNow = await now.merge()
        // cr.56: the repository and its secret this job run read (`depsOf`),
        // with the route's effective namespace (the confirm signed it).
        const depsNow = await depsOf(ctx.reads)
        const result = await runFileRestore(
          executor,
          {
            ...depsNow,
            snapshot: req.snapshot,
            archive: req.archive,
            target,
            mode,
            merge: mergeNow,
            selections: fresh.selections,
            addedForHardlinks: fresh.addedForHardlinks,
            options: req.options,
            ...(req.rate ? { rate: req.rate } : {}),
            warnings,
          },
          ctx.updateProgress,
        )
        // The audit record the job queue writes names the operation and its
        // params; the BYTES are only known when the client has finished, so
        // they get their own journald line at that moment. journald is
        // forensics — the authoritative answer is the filesystem itself.
        server.log.info(
          {
            event: 'backup.restore.files',
            user: identity.user,
            snapshot: req.snapshot,
            archive: req.archive,
            selections: fresh.selections.length,
            target,
            mode,
            merge: mergeNow,
            status: result.status,
            bytes: result.bytes ?? 0,
            restored: result.restored.length,
            missing: result.missing.length,
          },
          `audit: restored ${result.restored.length}/${result.selections.length} selection(s) of `
          + `${req.archive} from ${req.snapshot} into ${target} `
          + `(${mode}${mergeNow ? ', merge' : ''}, ${result.bytes ?? 0} bytes)`,
        )
        return result
      }),
      // cr.33 (§4.3): a restore is a data mover — the long lane. cr.54: it
      // holds its destination's filesystem keys shared for the run.
      { lane: 'long', locks: pre.locks },
    )
    reply.code(202)
    return { job }
  }
}

/** The new-LUN restore's backing as one guard run resolves it (cr.54). */
interface NewLunBacking {
  backing: ResolvedBacking
  /** The directory an image file is created in (file backings only). */
  dir?: string
  /** Set when the image lands on an AHR pool — the boot-ordering half (iscsi.8). */
  ahr?: ResolvedAhrPool
}

/**
 * The file restore's destination as one guard run reads it (cr.54): the path,
 * and every fact a gate, the revision or the job body asks of it, each read
 * lazily and once per run.
 */
interface RestoreDestination {
  target: string
  /** `stat -c %F`: 'directory', another kind, or null (absent, or no answer). */
  kind: () => Promise<string | null>
  /** Does the restore MERGE into an existing directory (in place, or a newLocation that exists)? */
  merge: () => Promise<boolean>
  /** Where the write and space probes go: the target, or the parent a new directory is created in. */
  writeDir: () => Promise<string>
  selection: () => Promise<SelectionFacts>
  space: () => Promise<{ refusal: string | null, warnings: string[] }>
  /** The destination filesystem's keys (`pathSourceClaims`), shared. */
  claims: () => Promise<SourceClaims>
}

/**
 * The file restore destination's revision (cr.54): what is at the path and
 * the filesystem it sits on, as the lock keys name it (`zfs:<pool guid>/…`,
 * `ahr:<vg uuid>`, `mount:<target>`). A directory that appears under a
 * newLocation path, a dataset unmounted from under the path, or a pool
 * re-created under the same name all move it.
 */
function restoreDestinationRevision(kind: string | null, claims: LockClaim[]): string {
  const keys = claims.map(c => `${c.key}:${c.mode}`).sort()
  return createHash('sha256').update(JSON.stringify({ kind, keys })).digest('hex')
}

/**
 * Validate that a repo write carries the identity its auth style needs (a token
 * id for token auth, a username for password auth). Returns an error message or
 * null when valid.
 */
function validateRepoAuth(repo: { authType: string, tokenId?: string, username?: string }): string | null {
  if (repo.authType === 'token' && !repo.tokenId)
    return 'Token auth requires a token id (user@realm!tokenname)'
  if (repo.authType === 'password' && !repo.username)
    return 'Password auth requires a username (user@realm)'
  return null
}
