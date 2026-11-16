import type { MountEntry, MountOptions, MountRequestOptions, MountSummary } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor, ExecResult } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { BoundId, ConfirmStore } from '../safety/confirm.js'
import type { Advisory, Gate, GuardReads, GuardSpec, Refusal } from '../safety/guard.js'
import type { IscsiPaths } from '../services/iscsi.js'
import type { LiveAtTarget } from '../services/mount-match.js'
import type { CredentialsFileContent, MountTestStages, StoredProbeCredentials } from '../services/mounts.js'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'
import { AbsolutePath, CreateMountRequest, DeleteMountQuery, MountCifsSec, MountNfsSec, MountStateRequest, MountTestRequest, normalizeMountTarget, UpdateMountRequest } from '@anas/shared'
import { CommandTimeoutError } from '../executor/deadline.js'
import { classifyKind, parseFindmnt, readFindmntTable } from '../parsers/findmnt.js'
import { addMount, ANAS_MARKER, carriesAutomount, carriesInlineSecret, cifsCredentialTokenScan, directMountOptionArgs, disableMount, enableMount, getMount, hasMount, isCifs, isNfs, linesFor, parseFstabDoc, removeMount, replaceMount, serializeMountLine } from '../parsers/fstab.js'
import { PVE_STORAGE_CFG, readPveMountPathsStrict, readPveTerritoryClaims, readZfsMountpoints } from '../parsers/pve-storage.js'
import { guardCheck, guardConfirm, guarded, GuardRefusalError, mountClaim, sendRefusal } from '../safety/guard.js'
import { ahrMountBase } from '../services/ahr-paths.js'
import { diagnoseBusyPath, enrichBusyError, formatHolders, runFuser, toolNotFound } from '../services/busy-diagnosis.js'
import { duplicateKeyRefusal } from '../services/config-duplicates.js'
import { editConfig, readConfig, writeFileAtomic } from '../services/config-writer.js'
import { configfsOptionsFrom, createIscsiClaimCache, heldByLun, heldByLunRefusal } from '../services/iscsi-held.js'
import { describeLive, liveAtTarget, specMatchesLive } from '../services/mount-match.js'
import {
  ahrPinnedSpecs,
  applyOption,
  applySecOption,
  buildBaseInventory,
  buildInventory,
  buildMountDetail,
  buildSpec,
  cleanMountStderr,
  createMountpointThroughOpenedParent,
  CredentialsContentError,
  CredentialsFileUninterpretableError,
  credsFileName,
  credsFilePath,
  deliveredMatchesIntent,
  effectiveCifsAccount,
  entryFromRequest,
  formatCredentials,
  fstabLineRevision,
  InvalidExtraOptionsError,
  isRemoteKind,
  mountpointReservedByPve,
  mountTargetRefusal,
  mountThroughOpenedDir,
  normalizeMountpointPath,
  parseSpec,
  probeInventoryHealth,
  ProbeRuntimeDirError,
  pveStorageFor,
  readCredentialsSecrets,
  readEffectiveOptions,
  readMdadmConfText,
  removeCredentialsFileIfUnreferenced,
  removeEmptyMountpointDir,
  removeMountpointLeafThroughOpenedParent,
  restoreFileBytes,
  rotateCredentialsFile,
  runMountTest,
  stopAutomountUnit,
  validatedExtraOptions,
  writeCredentialsFile,
} from '../services/mounts.js'
import { mountReferenceWarning, mountUnreadableWarning, poolReferenceKey, readMountReferences } from '../services/pool-references.js'
import { ownershipRefusal } from '../services/pve-footprint.js'
import { zodIssue } from '../validation.js'
import { requireIdentity } from './identity.js'

const SYSTEMCTL = '/usr/bin/systemctl'
const MOUNT = '/usr/bin/mount'
const UMOUNT = '/usr/bin/umount'
const LSOF = '/usr/bin/lsof'

/** A carriage return or line feed inside a credentials value (review 4, N6). */
const LINE_BREAK_RE = /[\r\n]/
/** Whitespace splitter for lsof columns. */
const WHITESPACE_RE = /\s+/
/** A bare PID (lsof second column). */
const PID_RE = /^\d+$/

export interface MountsRouteOptions {
  executor: CommandExecutor
  jobQueue: JobQueue
  confirmStore: ConfirmStore
  /** /etc/fstab location (config IS the API). Override via ANAS_FSTAB_PATH. */
  fstabPath: string
  /** Per-mount credentials directory (0600 root-only files). */
  credsDir: string
  /** storage.cfg location for read-only PVE tagging (undefined = default). */
  storagePath?: string
  /**
   * mdadm.conf location for read-only AHR-pin tagging (undefined = the default
   * / ANAS_MDADM_CONF). A pinned pool's LV spec is matched against the fstab
   * entry so AHR persistence stays hands-off in Mounts (§2.6).
   */
  mdadmConfPath?: string
  /**
   * iSCSI read-layer path overrides (story iscsi.6) — Unmount and Remove refuse
   * while a LUN's image file sits under the mountpoint. Real host paths by
   * default; overridable so a test never reads the kernel.
   */
  iscsiPaths?: IscsiPaths
  /**
   * Story cr.39 — the reference sources Unmount, Disable and Remove list in
   * their confirm (EPICS §2 Mounts: "unmount cross-checks shares and backup
   * tasks riding the path"): the same paths the share and task routes edit.
   * An absent path leaves that kind unchecked (never "unreadable").
   */
  smbConfPath?: string
  exportsPath?: string
  systemdDir?: string
  /**
   * TEST SEAM for POST /mounts/test's network stages (DNS + TCP to 2049/445):
   * a test host has no share server on those ports, so the mount stage — and
   * its verdict mapping — was unreachable from a route test. Production never
   * sets it; the real checks are the default.
   */
  mountTestStages?: MountTestStages
  /**
   * TEST SEAM for the fuser holder-name reads (D3): the `/proc` root
   * `busy-diagnosis` reads `<pid>/comm` from. A test whose fuser answers the
   * captured fixture points this at a fake proc tree so the holder names
   * resolve; production never sets it and the real `/proc` is read.
   */
  procRoot?: string
}

/** The verbs on an existing mount (create has its own spec: its object is an empty slot). */
type MountVerb = 'update' | 'mount' | 'enable' | 'unmount' | 'disable' | 'remove'

/** How a refusal sentence names each verb. */
const VERBING: Record<MountVerb, string> = {
  update: 'Editing',
  mount: 'Mounting',
  enable: 'Enabling',
  unmount: 'Unmounting',
  disable: 'Disabling',
  remove: 'Removing',
}

/**
 * What a mount verb acts on, read NOW (story cr.39, ruling (j)): the fstab
 * line for the mountpoint and what the kernel has at it. Every door reads its
 * own; nothing the route read reaches the job's gates.
 */
interface MountObject {
  mountpoint: string
  fstabText: string
  /** The fstab line's entry, or undefined (an ephemeral mount, or nothing). */
  entry?: MountEntry
  /** The kernel mount table lists the mountpoint (an armed automount alone is not "mounted"). */
  mounted: boolean
  live: LiveAtTarget
  /** The mount table could not be read (cr.60): `mounted`/`live` say nothing, and the table gate refuses. */
  tableUnreadable: boolean
}

/** What a create acts on: the mountpoint slot, and the fstab as it is now. */
interface MountSlot {
  mountpoint: string
  fstabText: string
}

/**
 * Mounts (Epic 18) — external & local storage. Pure management: ANAS surgically
 * edits /etc/fstab (round-trip parser) and invokes mount/umount; the kernel and
 * systemd's fstab generator do the work. PVE-owned mounts (read-only
 * storage.cfg parse) are tagged hands-off and reject every mutation. All
 * mutations are jobs (202); status never touches a mountpoint synchronously
 * (guarded `stat -f` in a child process).
 *
 * Story cr.39 (WAVE3-DESIGN §2.5, ruling (j)): every verb is a guard spec. The
 * route runs its gates, the job runs the SAME gates again against facts read
 * when it starts, and the queue starts it only while it holds the mountpoint's
 * `mount:<path>` lock.
 */
export async function mountsRoutes(server: FastifyInstance, opts: MountsRouteOptions) {
  const { executor, jobQueue, confirmStore, fstabPath, credsDir, storagePath, mdadmConfPath, mountTestStages } = opts
  const iscsiPaths = opts.iscsiPaths ?? {}
  const procRoot = opts.procRoot

  /** The per-run reads the mount gates share (one per guard run, never across doors). */
  const mountReads = {
    // cr.60 (review L26): the gates read the table STRICTLY — `null` is
    // unreadable (a findmnt that failed, exited non-zero or answered in an
    // unknown shape), never "nothing mounted".
    findmnt: (reads: GuardReads) => reads.once('findmnt', () => readFindmntTable(executor)),
    fstab: (reads: GuardReads) => reads.once('fstab', () => readConfig(fstabPath)),
    // cr.60 (from cr.54's report): the STRICT reader — an unreadable
    // storage.cfg refuses, never an empty map. cr.60r (review possible 3):
    // the claims also cover every path a zfspool dataset is LIVE at, derived
    // from the SAME per-run strict table read the target gates share (no
    // second findmnt); an unreadable table, when a zfspool needs it, is its
    // own refusal — never "no live claim".
    pvePaths: (reads: GuardReads) => reads.once('pve-mount-paths', () =>
      readPveTerritoryClaims(storagePath ?? PVE_STORAGE_CFG, () => mountReads.findmnt(reads))),
    ahrSpecs: (reads: GuardReads) => reads.once('ahr-specs', () => readAhrSpecs()),
    claims: (reads: GuardReads) => reads.once('iscsi-claims', async () => createIscsiClaimCache(executor, iscsiPaths)),
  }

  /** The mount at `mountpoint` as the node has it now. Never null: absence is each verb's own gate. */
  async function readMountObject(mountpoint: string, reads: GuardReads): Promise<MountObject> {
    const [findmntText, fstabText] = await Promise.all([mountReads.findmnt(reads), mountReads.fstab(reads)])
    return {
      mountpoint,
      fstabText,
      entry: getMount(fstabText, mountpoint),
      mounted: mountedIn(findmntText ?? '', mountpoint),
      live: liveAtTarget(parseFindmnt(findmntText ?? ''), mountpoint),
      tableUnreadable: findmntText === null,
    }
  }

  // --- the gates (each one function, run by both doors) -------------------

  /**
   * cr.60 (review L26): every verb that acts on the TARGET decides on the live
   * mount table (mounted?, what is mounted, the foreign-mount check). When it
   * cannot be read nothing is known about the target, so the verb refuses —
   * at the route and again in the job — instead of reading "nothing mounted".
   */
  const tableGate: Gate<MountObject> = async o => o.tableUnreadable
    ? { status: 503, code: 'UNAVAILABLE', message: `ANAS could not read the kernel mount table (findmnt), so it cannot check what is mounted at '${o.mountpoint}' — nothing was done` }
    : null

  /** Reject a mutation on a PVE-owned mount (hands-off). */
  const pveGate: Gate<MountObject> = async (o, reads) => {
    if (mountpointReservedByPve(o.mountpoint))
      return pveOwnedRefusal(o.mountpoint)
    const paths = await mountReads.pvePaths(reads)
    if (paths === 'storage-cfg')
      return pveConfigUnreadable(o.mountpoint)
    if (paths === 'findmnt')
      return pveLiveUnreadable(o.mountpoint)
    return pveStorageFor(o.mountpoint, paths) ? pveOwnedRefusal(o.mountpoint) : null
  }

  /**
   * cr.60r: a zfspool storage's dataset claims the paths it is LIVE at, so
   * with the mount table unreadable the daemon cannot see whether the path is
   * PVE's — the verb (enable and the create door included: neither has
   * another table gate) refuses 503 naming the read, never "not PVE's".
   */
  function pveLiveUnreadable(mountpoint: string): Refusal {
    return { status: 503, code: 'UNAVAILABLE', message: `ANAS could not read the kernel mount table (findmnt), so it cannot check '${mountpoint}' against the paths PVE's ZFS storage datasets are mounted at — nothing was done` }
  }

  function pveOwnedRefusal(mountpoint: string): Refusal {
    return { status: 400, code: 'VALIDATION_ERROR', message: `Mount '${mountpoint}' is PVE-owned (hands-off) and cannot be modified by ANAS` }
  }

  /**
   * An unreadable storage.cfg (cr.60, from cr.54's report) is cr.47(b)'s
   * `config-unreadable` verdict — the daemon cannot see whether the path is
   * PVE's, so the verb refuses (400, the fact every other territory door
   * states), never "no PVE storage here". The fixed PVE paths are answered
   * before it: they need no file.
   */
  function pveConfigUnreadable(mountpoint: string): Refusal {
    return ownershipRefusal({
      kind: 'config-unreadable',
      reason: `PVE storage configuration is unreadable (${storagePath ?? PVE_STORAGE_CFG}) — '${mountpoint}' cannot be checked against the paths PVE storage claims, so the change is refused until it can be read`,
    })
  }

  /**
   * Reject a mutation on an AHR pool's persistence (hands-off — mirrors the
   * PVE gate). A Mounts unmount/delete/edit on a pool's LV entry would rip the
   * pool's persistence out from under the Hybrid RAID feature. Matches on the
   * LV SPEC via the shared inventory tagging (never the mountpoint), so a
   * custom-mountpoint pool is still refused.
   */
  const ahrGate: Gate<MountObject> = async (o, reads) => {
    if (!mdadmConfPath)
      return null
    const ahrSpecs = await mountReads.ahrSpecs(reads)
    if (ahrSpecs.size === 0)
      return null
    const row = buildBaseInventory((await mountReads.findmnt(reads)) ?? '', o.fstabText, new Map(), ahrSpecs).find(r => r.mountpoint === o.mountpoint)
    if (!row?.ahrManaged)
      return null
    return { status: 400, code: 'VALIDATION_ERROR', message: `Mount '${o.mountpoint}' is an ANAS Hybrid RAID (AHR) pool — manage it from the Hybrid RAID view, not the Mounts feature` }
  }

  /**
   * NAS-surface guard (operator ruling): ANAS mutates REMOTE share mounts
   * only. Local filesystems are observe-only — the local-drive path is ZFS or
   * AHR, not generic mount management. Unknown targets pass to the verbs' own
   * existence gates.
   */
  const remoteGate: Gate<MountObject> = async (o, reads) => {
    let kind: string | undefined = o.entry ? classifyKind(o.entry.fstype, o.entry.spec) : undefined
    if (kind === undefined)
      kind = buildBaseInventory((await mountReads.findmnt(reads)) ?? '', '', new Map()).find(r => r.mountpoint === o.mountpoint)?.type
    if (kind === undefined || isRemoteKind(kind))
      return null
    return { status: 400, code: 'VALIDATION_ERROR', message: `Mount '${o.mountpoint}' is not an ANAS-managed filesystem — ANAS manages remote (NFS/CIFS) shares only` }
  }

  /**
   * What is mounted at the mountpoint when it is NOT what the fstab line
   * names (story ident.4 (e), audit #18): a hard 409, no confirm. A local disk
   * mounted by hand where a failed CIFS line points is the case: before
   * ident.4 a Remove, Unmount, Disable or Edit of the CIFS line unmounted the
   * disk, and a Mount stacked the share on top of it. Nothing mounted (or only
   * an armed automount placeholder) is not a mismatch.
   */
  function foreignGate(verbing: string): Gate<MountObject> {
    return async (o) => {
      if (!o.entry || !o.live.real || specMatchesLive(o.entry, o.live.real))
        return null
      return {
        status: 409,
        code: 'CONFLICT',
        reason: 'mount-mismatch',
        message: `${verbing} refused: '${o.mountpoint}' has ${describeLive(o.live.real)} mounted on it, not ${o.entry.spec} (${o.entry.fstype}) that its /etc/fstab line names. `
          + `ANAS unmounts or mounts over only the filesystem the line configures. Unmount ${o.mountpoint} on the node yourself (umount ${o.mountpoint}), then try again.`,
      }
    }
  }

  /**
   * Refuse an unmount/disable/remove while a LUN's image file lives under the
   * mountpoint (story iscsi.6) — a HARD refusal, no confirm bypass, at the
   * route and again in the job (cr.39): `umount` of a filesystem holding an
   * open fileio backing file does not fail the way a share does. LIO holds the
   * INODE, so an unmount can succeed and leave the LUN serving a file that is
   * no longer reachable by any path — and `fuser`/`lsof` show nothing at all
   * (GT-41). It runs before the busy confirm: a lazy unmount is precisely the
   * wrong answer to a LUN.
   */
  function lunGate(verbing: string): Gate<MountObject> {
    return async (o, reads) => {
      const held = await heldByLun(await mountReads.claims(reads), { path: o.mountpoint })
      if (!held)
        return null
      const refusal = heldByLunRefusal(`mount '${o.mountpoint}'`, verbing, held)
      return { status: 409, code: 'CONFLICT', reason: refusal.reason, message: refusal.message }
    }
  }

  /** Is `file` inside ANAS's own credentials directory (a file ANAS wrote and may rewrite)? */
  function isAnasCredentialsFile(file: string): boolean {
    return resolvePath(file).startsWith(`${resolvePath(credsDir)}/`)
  }

  /**
   * THE gate for a line that carries a secret ON it (cr3.mounts M6, follow-up
   * (2), reviews 2 and 3). A secret never rides a command line, and only the
   * migrating Save may move one; every other door refuses, nothing changed:
   *  - a verbatim secret token: a password on a line that is not CIFS
   *    (nothing can hold it), or a CIFS password spelled in a way mount.cifs
   *    does not read as that option (`PASSWORD=`; it reads exact, case-
   *    sensitive keys) — Mount and Edit refuse naming the key;
   *  - an inline password / alternate password on a line that ALSO names
   *    the operator's own credentials file (outside ANAS's directory): ANAS
   *    does not copy or edit that file (ruling, review 3) — Mount and Edit
   *    refuse, saying exactly what to move where;
   *  - otherwise an inline password / alternate password: Mount refuses with
   *    the Edit-then-Save sentence (M6); Edit is the migrating Save; Disable
   *    of a LEGACY `#ANAS ` line (whose conversion re-serialises it) refuses
   *    with Enable-then-Edit-and-Save.
   * Only KEYS are ever named, never a value.
   */
  function inlineSecretGate(verb: 'mount' | 'update' | 'disable'): Gate<MountObject> {
    return async (o) => {
      const e = o.entry
      if (!e)
        return null
      // cr3.mounts review 4 (D4): a token with an escaped separator (`\054`,
      // `\075`) is opaque — on ANY line, every verb that acts on the line
      // refuses, naming the token's POSITION, never its content.
      if (e.escapedSeparatorTokens?.length) {
        const which = e.escapedSeparatorTokens.length === 1 ? `option ${e.escapedSeparatorTokens[0]}` : `options ${e.escapedSeparatorTokens.join(', ')}`
        return {
          status: 400,
          code: 'VALIDATION_ERROR',
          reason: 'escaped-separator',
          message: `${VERBING[verb]} '${o.mountpoint}' is refused: ${which} of its /etc/fstab line contains an escaped ',' or '=' (\\054 or \\075), which libmount turns into a separator before mount.cifs reads the option, so ANAS cannot tell what that option says — nothing was done. Fix the line on the node, then try again. (Unmount and Remove still work.)`,
        }
      }
      // cr3.mounts review 4 (D5): mount.cifs reads EVERY credentials file a
      // line names, in order; ANAS would know only the last.
      const scan = cifsCredentialTokenScan(o.fstabText, o.mountpoint)
      if (isCifs(e.fstype) && scan && scan.files > 1) {
        return {
          status: 400,
          code: 'VALIDATION_ERROR',
          reason: 'several-credentials-files',
          message: `${VERBING[verb]} '${o.mountpoint}' is refused: its /etc/fstab line names a credentials file ${scan.files} times (credentials=/cred=). mount.cifs reads each of them in order, and ANAS will not choose one for it — nothing was done. Keep one credentials file on the line on the node, then try again.`,
        }
      }
      if (verb === 'disable' && !parseFstabDoc(o.fstabText).some(l => l.kind === 'entry' && l.entry.mountpoint === o.mountpoint && l.raw.startsWith(ANAS_MARKER)))
        return null
      if (e.secretOptions?.length) {
        const keys = [...new Set(e.secretOptions.map(t => `${t.split('=')[0]}=`))].join(', ')
        return {
          status: 400,
          code: 'VALIDATION_ERROR',
          reason: 'inline-secret-option',
          message: isCifs(e.fstype)
            ? `${VERBING[verb]} '${o.mountpoint}' is refused: its /etc/fstab line keeps ${keys}, a password spelled in a way mount.cifs does not read as that option (it reads exactly password=, pass=, password2=, pass2=), so ANAS cannot tell what the mount used and will not move it into a credentials file or put it on a command line — nothing was done. `
            + `Respell or remove ${keys} on the line on the node, then try again.`
            : `${VERBING[verb]} '${o.mountpoint}' is refused: its /etc/fstab line keeps a password option inline (${keys}) on a ${e.fstype} line, where no credentials file can hold it, and ANAS never puts a secret on a command line, where any process on the node can read it — nothing was done. `
              + `Remove ${keys} from the line on the node (a ${e.fstype} mount does not use it), then try again.`,
        }
      }
      const inline = e.inlineCredentials
      if (inline?.password === undefined && inline?.password2 === undefined)
        return null
      // Only the keys actually on the line are named (review 4, D1).
      const what = (scan?.secretKeys ?? []).map(k => `${k}=`).join(' and ') || 'a password'
      if (e.credentialsFile && !isAnasCredentialsFile(e.credentialsFile)) {
        // cr3.mounts review 4 (D1): what to do, PER KEY actually on the line.
        // When the file already holds that kind of password, the inline one
        // is not used (the file's wins) and adding a second line to the file
        // would change the account (the last line wins): only remove it.
        const file = e.credentialsFile
        const inFile = await readCredentialsSecrets(file).then(c => c ?? {}, () => undefined)
        const steps = (scan?.secretKeys ?? []).map((key) => {
          const field = key === 'password2' || key === 'pass2' ? 'password2' : 'password'
          if (inFile === undefined)
            return `the inline ${key}=: if ${file} already has a ${field}= line, the inline one is not used (the file's wins) — remove it from the line; if it has none, move it into ${file} as a ${field}= line and remove it from the line`
          return inFile[field] !== undefined
            ? `the inline ${key}= is not used (the file's ${field} wins): remove it from the line`
            : `move the inline ${key}= into ${file} as a ${field}= line and remove it from the line`
        })
        return {
          status: 400,
          code: 'VALIDATION_ERROR',
          reason: 'operator-credentials-file',
          message: `${VERBING[verb]} '${o.mountpoint}' is refused: its /etc/fstab line names your credentials file ${file} (outside ANAS's credentials directory ${credsDir}) and also keeps ${what} inline. ANAS does not copy or edit your file, so it does not migrate this line — nothing was changed. `
            + `On the node: ${steps.join('; ')}. Then try again.`,
        }
      }
      if (verb === 'mount') {
        // M6: the direct mount (cr.52r D3) lifts an inline secret out of the
        // argv, so mount.cifs ran without it and waited on a prompt.
        return {
          status: 400,
          code: 'VALIDATION_ERROR',
          reason: 'inline-credentials',
          message: `Mount '${o.mountpoint}' keeps its password inline in /etc/fstab, and ANAS mounts a CIFS share only from a protected credentials file — nothing was done. `
            + `Open Edit and Save: the password moves to a root-only credentials file and the share is mounted. (Or mount it on the node yourself: mount ${o.mountpoint})`,
        }
      }
      if (verb === 'disable') {
        return {
          status: 400,
          code: 'VALIDATION_ERROR',
          reason: 'inline-credentials',
          message: `Disabling '${o.mountpoint}' is refused: its /etc/fstab line (already disabled in the old #ANAS form) keeps ${what} inline, and rewriting the line would lose it — nothing was changed. `
            + `Enable it, then open Edit and Save to move the password into a protected credentials file.`,
        }
      }
      return null
    }
  }

  /**
   * What a migrating Save writes into the credentials file (cr3.mounts
   * reviews 2/3), decided before the first act: the account mount.cifs used
   * — the line's inline tokens and, when the line names ANAS's OWN file, that
   * file's content, by mount.cifs' precedence ({@link effectiveCifsAccount}).
   * Refused, nothing changed, when the line spells a credential token in a
   * way mount.cifs does not read, when the file cannot be read, when there is
   * no username anywhere, or when a value would break the file's lines.
   * (A line naming the OPERATOR's file never gets here: inlineSecretGate.)
   */
  async function migrationPlan(existing: MountEntry, fstabText: string): Promise<{ refusal: string } | { content: CredentialsFileContent }> {
    const mp = existing.mountpoint
    const scan = cifsCredentialTokenScan(fstabText, mp)
    if (scan && scan.unhonoured.length > 0) {
      const keys = scan.unhonoured.join(', ')
      return { refusal: `Saving '${mp}' is refused: its /etc/fstab line spells ${keys} in a way mount.cifs does not read as that option (it reads exactly user=/username=, dom=/domain=/workgroup=, cred=/credentials=), so ANAS cannot tell which account the mount used and does not migrate its password — nothing was changed. Respell or remove ${keys} on the line on the node, then Save again.` }
    }
    let file: Partial<CredentialsFileContent> | null = null
    if (existing.credentialsFile) {
      try {
        file = await readCredentialsSecrets(existing.credentialsFile)
      }
      catch (err) {
        if (err instanceof CredentialsFileUninterpretableError)
          return { refusal: `Saving '${mp}' is refused: ${err.message} — nothing was migrated or changed. Fix the file on the node, then Save again.` }
        return { refusal: `Could not read the credentials file '${existing.credentialsFile}' this line names (${(err as NodeJS.ErrnoException).code ?? String(err)}) — nothing was changed` }
      }
      // review 4 (N6): a line break in the FILE's value is the file's to fix.
      const broken = file ? (Object.entries(file) as Array<[string, string]>).find(([, v]) => LINE_BREAK_RE.test(v)) : undefined
      if (broken)
        return { refusal: `Saving '${mp}' is refused: the ${broken[0]} in the credentials file '${existing.credentialsFile}' contains a carriage return or line break, which ANAS will not copy — nothing was changed. Fix the file on the node, then Save again.` }
    }
    const account = effectiveCifsAccount(existing, fstabText, file)
    if (!account.username)
      return { refusal: `Saving '${mp}' is refused: its /etc/fstab line keeps a password inline but names no username (on the line or in its credentials file), so a credentials file written from it would not mean what the line means — nothing was changed. Add username=<name> to the line on the node, then Save again.` }
    const content: CredentialsFileContent = {
      username: account.username,
      ...(account.password !== undefined ? { password: account.password } : {}),
      ...(account.password2 !== undefined ? { password2: account.password2 } : {}),
      ...(account.domain !== undefined ? { domain: account.domain } : {}),
    }
    try {
      formatCredentials(content)
    }
    catch (err) {
      if (err instanceof CredentialsContentError)
        return { refusal: `Saving '${mp}' is refused: ${err.message}. Fix the line on the node, then Save again.` }
      throw err
    }
    return { content }
  }

  /**
   * The old account's alternate password a rotation carries into the new
   * file (cr3.mounts review 3 (3)): only when the old content can be read and
   * the typed username is the old account's. Never a reason to fail the
   * rotation — the notes say what was not carried, and why.
   */
  async function alternatePasswordToCarry(existing: MountEntry, fstabText: string, newUser: string): Promise<{ password2?: string, notes: string[] }> {
    let file: Partial<CredentialsFileContent> | null = null
    if (existing.credentialsFile) {
      // cr3.mounts review 4 (P1, ruling): nothing is ever copied out of the
      // OPERATOR's file — only ANAS's own file carries its alternate password.
      if (!isAnasCredentialsFile(existing.credentialsFile))
        return { notes: [`Any alternate password in '${existing.credentialsFile}' was not carried over to the new credentials — ANAS does not copy anything out of your file.`] }
      try {
        file = await readCredentialsSecrets(existing.credentialsFile)
      }
      catch (err) {
        const why = err instanceof CredentialsFileUninterpretableError ? err.message : `it could not be read (${(err as NodeJS.ErrnoException).code ?? String(err)})`
        return { notes: [`The alternate password in '${existing.credentialsFile}' was not carried over to the new credentials: ${why}.`] }
      }
    }
    const account = effectiveCifsAccount(existing, fstabText, file)
    if (account.password2 === undefined)
      return { notes: [] }
    if (account.username !== newUser)
      return { notes: [`The alternate password of ${account.username ? `'${account.username}'` : 'the old account'} was not carried over to '${newUser}' — it belongs to the old account.`] }
    return { password2: account.password2, notes: [] }
  }

  /**
   * cr3.mounts review 4 (N1): after an edit took an inline secret OFF the
   * line (a migrating Save, a Remove), the config writer's backup
   * `<fstab>.bak` — a copy of the file as it was before that edit, 0644 —
   * still holds it. A byte-identical second edit does not refresh it (the
   * writer skips a no-op edit, `next === before`), so the line in the backup
   * is replaced through the writer's own atomic helper: the old raw line by
   * the new one (or dropped, after a Remove); every other byte of the backup
   * stays. When the secret is still in the backup after that (an older
   * spelling of the line), the job says so with the one command that clears it.
   */
  async function scrubFstabBackup(oldRaw: string, newRaw: string | null, entry: MountEntry): Promise<string | undefined> {
    const bak = `${fstabPath}.bak`
    const secrets = [entry.inlineCredentials?.password, entry.inlineCredentials?.password2, ...(entry.secretOptions ?? [])].filter((v): v is string => typeof v === 'string' && v !== '')
    const clear = `/etc/fstab's backup ${bak} still holds the password this edit took off the line — clear it on the node: cp ${fstabPath} ${bak}`
    let text: string
    try {
      text = await readFile(bak, 'utf8')
    }
    catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : clear
    }
    const holds = (t: string): boolean => t.split('\n').includes(oldRaw) || secrets.some(sec => t.includes(sec))
    if (!holds(text))
      return undefined
    const next = text.split('\n').flatMap(l => (l === oldRaw ? (newRaw === null ? [] : [newRaw]) : [l])).join('\n')
    if (holds(next))
      return clear
    return writeFileAtomic(bak, next).then(() => undefined, () => clear)
  }

  /** A state gate: `holds(o)` must be true, else the refusal (the route's 4xx, the job's error). */
  function stateGate(holds: (o: MountObject) => boolean, refusal: Refusal): Gate<MountObject> {
    return async o => (holds(o) ? null : refusal)
  }

  /**
   * The verb's gate list, in the order the route has always answered them.
   * The SAME list runs in the job (ruling (j)), so a state that changed while
   * the job waited for its lock or a slot — a LUN created under the
   * mountpoint, the line disabled, the share unmounted by hand — refuses there
   * with the sentence the route would have given.
   */
  function mountGates(mp: string, verb: MountVerb): Gate<MountObject>[] {
    const verbing = VERBING[verb]
    const gates: Gate<MountObject>[] = [pveGate, ahrGate]
    // Enable touches fstab alone; every other verb decides on the live table.
    if (verb !== 'enable')
      gates.push(tableGate)
    if (verb === 'update') {
      gates.push(
        stateGate(o => !!o.entry, { status: 404, code: 'NOT_FOUND', message: `Mount '${mp}' is not in /etc/fstab` }),
        // cr3.mounts M4: an edit re-mounts the line, so a DISABLED line (which
        // Mount refuses) is refused here too — an edit of one used to mount it.
        stateGate(o => !o.entry?.disabled, { status: 400, code: 'VALIDATION_ERROR', message: `Mount '${mp}' is disabled — enable it first, then edit it` }),
      )
    }
    if (verb === 'remove')
      gates.push(stateGate(o => !!o.entry || o.mounted, { status: 404, code: 'NOT_FOUND', message: `Mount '${mp}' not found` }))
    gates.push(remoteGate)
    // Enable touches fstab alone; every other verb acts on the target.
    if (verb !== 'enable')
      gates.push(foreignGate(verbing))
    if (verb === 'mount') {
      gates.push(
        stateGate(o => !!o.entry || o.mounted, { status: 404, code: 'NOT_FOUND', message: `Mount '${mp}' is not configured and not mounted` }),
        stateGate(o => !o.entry?.disabled, { status: 400, code: 'VALIDATION_ERROR', message: `Mount '${mp}' is disabled — enable it first` }),
        // cr.52r P2: this verb MOUNTS the stored path again, so the stored
        // path runs the mount-target refusal like every setting door — a path
        // that has since resolved into a protected tree (a swapped parent, a
        // new symlink) refuses here, at the route and again in the job.
        async o => mountTargetRefusal(o.mountpoint),
      )
    }
    // cr.52s-a (review P6): an edit RE-MOUNTS the stored path (`remountEntry`:
    // umount + a direct mount, or the busy `-o remount` fallback), so it asks
    // the same refusal — as a gate, so it answers at the route and again in
    // the job BEFORE the fstab line is rewritten (a refusal after the edit
    // would leave the op half-done).
    if (verb === 'update')
      gates.push(async o => mountTargetRefusal(o.mountpoint), async o => ahrBaseRefusal(o.mountpoint))
    // cr3.mounts M6, follow-up (2), reviews 2 and 3: a secret on the line
    // never rides a command line and is never lost by a door that is not the
    // migrating Save (inlineSecretGate).
    if (verb === 'mount' || verb === 'update' || verb === 'disable')
      gates.push(inlineSecretGate(verb))
    if (verb === 'enable') {
      gates.push(
        stateGate(o => !!o.entry, { status: 400, code: 'VALIDATION_ERROR', message: `Mount '${mp}' is not in /etc/fstab` }),
        stateGate(o => !!o.entry?.disabled, { status: 400, code: 'VALIDATION_ERROR', message: `Mount '${mp}' is not disabled` }),
      )
    }
    if (verb === 'disable')
      gates.push(stateGate(o => !!o.entry, { status: 400, code: 'VALIDATION_ERROR', message: `Mount '${mp}' is not in /etc/fstab — nothing to disable` }))
    if (verb === 'unmount')
      gates.push(stateGate(o => o.mounted, { status: 404, code: 'NOT_FOUND', message: `Mount '${mp}' is not currently mounted` }))
    // cr4.conf D-21 (the one rule /etc/exports follows as D-2): a verb that
    // changes or removes a line refuses when the mountpoint is on more than
    // one — the first-match editors rewrite or delete ONE line and report
    // success while the other line still mounts it at boot. Refused at the
    // door, before any confirm is minted, and asked again in the job's last-
    // moment transform; create, mount and unmount touch no line.
    if (verb === 'update' || verb === 'enable' || verb === 'disable' || verb === 'remove')
      gates.push(async o => duplicateFstabLines(o.fstabText, mp))
    // cr3.mounts H2: an edit RE-MOUNTS (`remountEntry` unmounts first, or
    // mounts over an unmounted target), so it takes the LUN gate the other
    // unmounting verbs take — the same hard 409, route and job.
    if (verb === 'unmount' || verb === 'disable' || verb === 'remove' || verb === 'update')
      gates.push(lunGate(verbing))
    return gates
  }

  /**
   * cr4.conf D-21: the refusal for a mountpoint on more than one /etc/fstab
   * line (the number comes from the fstab parser itself), or null when it is
   * on one line or none. One rule with /etc/exports (D-2) — see
   * services/config-duplicates.ts.
   */
  function duplicateFstabLines(text: string, mp: string): Refusal | null {
    const lines = linesFor(text, mp)
    return lines.length > 1 ? duplicateKeyRefusal(mp, lines, '/etc/fstab') : null
  }

  /**
   * What rides the mountpoint (story cr.39, the cr.24 helper): one advisory
   * per share, export, backup/cloud task or nested mount whose path is at or
   * under it, and one per source that could not be read. Warn, never refuse
   * (EPICS §3 Q4); the job reports any the confirm did not list.
   */
  async function mountAdvisories(o: MountObject): Promise<Advisory[]> {
    const read = await readMountReferences({
      executor,
      mountpoint: o.mountpoint,
      fstabPath,
      ...(opts.smbConfPath ? { smbConfPath: opts.smbConfPath } : {}),
      ...(opts.exportsPath ? { exportsPath: opts.exportsPath } : {}),
      ...(opts.systemdDir ? { systemdDir: opts.systemdDir } : {}),
    })
    return [
      ...read.refs.map(ref => ({ key: `ref:${poolReferenceKey(ref)}`, warning: mountReferenceWarning(ref) })),
      ...read.unreadableSources.map(src => ({ key: `unreadable:${src.kind}`, warning: mountUnreadableWarning(src, o.mountpoint) })),
    ]
  }

  /**
   * The credentials file a Remove deletes (ident.4 (d)): the file the line
   * names, or (a CIFS line naming none) this mountpoint's own hashed name —
   * never the flattened pre-ident.4 name, which two mountpoints could share.
   */
  function credentialsFileOf(o: MountObject): string | undefined {
    // cr3.mounts L11: a session (no-line) CIFS mount ANAS created named its
    // file by the same hashed name — a Remove of it deletes that file too
    // (one left by a create from before L11 removed it at mount time).
    const kind = o.entry
      ? classifyKind(o.entry.fstype, o.entry.spec)
      : (o.live.real ? classifyKind(o.live.real.fstype, o.live.real.source) : undefined)
    return o.entry?.credentialsFile ?? (kind === 'cifs' ? credsFilePath(credsDir, o.mountpoint) : undefined)
  }

  /**
   * The guard spec of a verb on an existing mount (story cr.39, WAVE3-DESIGN
   * §3.3 Mount row):
   *  - id: the fstab line's spec + type (what the ident.4 foreign check
   *    compares), or the live mount's for an ephemeral one — a line replaced
   *    by another share between the request and the job is another mount;
   *  - revision (update): the line's sha256 — the edit writes a merge of the
   *    line the request read, so a line changed meanwhile refuses
   *    STATE_CHANGED instead of being overwritten;
   *  - scope (remove): the credentials file it deletes, bound into the
   *    confirm with the request (`removeMountpointDir`);
   *  - advisories (unmount, disable, remove): what rides the path;
   *  - locks: `mount:<path>`, exclusive, for every verb.
   */
  function mountGuardSpec(mp: string, verb: MountVerb): GuardSpec<MountObject> {
    return {
      operation: `mount.${verb}`,
      object: {
        what: `Mount '${mp}'`,
        read: reads => readMountObject(mp, reads),
        id: async (o) => {
          if (o.entry)
            return { spec: o.entry.spec, fstype: o.entry.fstype }
          if (o.live.real)
            return { spec: o.live.real.source, fstype: o.live.real.fstype }
          return { spec: 'none', fstype: 'none' }
        },
        ...(verb === 'update' ? { revision: async (o: MountObject) => fstabLineRevision(o.fstabText, o.mountpoint) } : {}),
        ...(verb === 'remove' ? { scope: async (o: MountObject) => ({ credentialsFile: credentialsFileOf(o) ?? 'none' }) } : {}),
        // `holders` is bound by the busy confirm only (nf.3 D10, `confirmScope`).
        scopeLabels: { credentialsFile: 'the credentials file to remove', holders: 'the holders a forced unmount detaches' },
        unbound: part => part === 'revision'
          ? `Could not read the /etc/fstab line of '${mp}' — refusing an edit that cannot be bound to it`
          : `Could not read what ${VERBING[verb].toLowerCase()} '${mp}' would change — refusing`,
      },
      gates: mountGates(mp, verb),
      ...(verb === 'unmount' || verb === 'disable' || verb === 'remove' ? { advisories: mountAdvisories } : {}),
      locks: async () => [mountClaim(normalizeMountpointPath(mp))],
    }
  }

  /**
   * The guard spec of a create: the object is the mountpoint SLOT, and its
   * gates are the mountpoint-safety rules — never PVE territory, never a
   * system path (cr.18, review M7.3), never a PVE storage, never an existing
   * ZFS dataset's mountpoint, never a mountpoint an fstab line already owns.
   * cr.18 (review M7.2) made the last one hold for EVERY create, persistent or
   * not, because the credentials file is named by the mountpoint; cr.39 runs
   * it in the job too, so a line added while a non-persistent create waited
   * refuses before its credentials are written over that line's.
   *
   * The object's identity (cr.64b2) is the fstab line the create WRITES —
   * source + target + fstype, `identity` built from the one request — so the
   * non-empty-mountpoint confirm binds the mount the operator is climbing the
   * ruling over: a replay that would write another line (another share, server
   * or target) is 409 IDENTITY_MISMATCH, and the whole request is signed so a
   * changed body is CONFIRM_SCOPE_CHANGED naming the field.
   */
  function createGuardSpec(mp: string, identity: BoundId): GuardSpec<MountSlot> {
    return {
      operation: 'mount.create',
      object: {
        what: `Mountpoint '${mp}'`,
        read: async reads => ({ mountpoint: mp, fstabText: await mountReads.fstab(reads) }),
        id: async () => identity,
        unbound: () => `Could not read the mountpoint '${mp}' — refusing`,
      },
      gates: [
        // cr.52r doc ruling: /mnt/pve and /etc/pve answer through the shared
        // refusal below — the ONE 409 (reason system-mount-target, the
        // PVE-territory sentence named in the refusal's own reason), not this
        // door's old 400. The pveGate (PVE-owned mount verbs) is unchanged.
        // cr.52 (review H1): one shared system-path refusal at every door that
        // sets a mountpoint — the mount takes the 409 with the shared code and
        // sentence, and the job re-runs the gate under its lock.
        async s => mountTargetRefusal(s.mountpoint),
        async s => ahrBaseRefusal(s.mountpoint),
        async (s, reads) => {
          const paths = await mountReads.pvePaths(reads)
          if (paths === 'storage-cfg')
            return pveConfigUnreadable(s.mountpoint)
          if (paths === 'findmnt')
            return pveLiveUnreadable(s.mountpoint)
          return pveStorageFor(s.mountpoint, paths)
            ? { status: 400, code: 'VALIDATION_ERROR', message: `Mountpoint '${s.mountpoint}' belongs to a PVE storage (hands-off)` }
            : null
        },
        // pvepool.1 review fix 1: the mountpoint list is three-valued — absent
        // `zfs` ([]) fails open, an UNREADABLE answer (null) tightens: "could
        // not check" never gets to read as "nothing there".
        async (s) => {
          const zfsMountpoints = await readZfsMountpoints(executor)
          if (zfsMountpoints === null)
            return { status: 400, code: 'VALIDATION_ERROR', message: `ANAS could not verify whether '${s.mountpoint}' is a ZFS dataset mountpoint (zfs list failed) — the mount is refused until the ZFS answer is readable` }
          return zfsMountpoints.some(m => m.mountpoint === s.mountpoint)
            ? { status: 400, code: 'VALIDATION_ERROR', message: `Mountpoint '${s.mountpoint}' is a ZFS dataset mountpoint` }
            : null
        },
        async s => hasMount(s.fstabText, s.mountpoint)
          ? { status: 409, code: 'CONFLICT', message: `Mount '${s.mountpoint}' is already in /etc/fstab` }
          : null,
      ],
      locks: async () => [mountClaim(normalizeMountpointPath(mp))],
    }
  }

  /**
   * A forced (lazy) unmount detaches the holders the operator confirmed — and
   * only those (story cr.39, §2.5 "holders"). Right before the `umount -l`,
   * the job lists the holders again: one the confirm did not name refuses the
   * job, nothing done. A holder that has gone since is no reason to stop.
   * A re-listing that gets no answer (D3: the tool went, or timed out) cannot
   * show the holders are still only the confirmed ones, so it refuses too —
   * a forced detach is never done on an unknowable holder set.
   *
   * `confirmed` is the set the CONFIRM bound (nf.3 D10): the resend is
   * accepted only when its listing reads as that set ({@link boundHolders}),
   * so the job compares against what the operator was shown, never against a
   * re-listing nobody saw. Compared in the bound form ({@link holderKey}).
   */
  async function assertNoNewHolders(mountpoint: string, confirmed: Holder[]): Promise<void> {
    const listed = new Set(confirmed.map(holderKey))
    const listing = await listHolders(executor, mountpoint, procRoot)
    if (listing.state === 'unknown') {
      throw new GuardRefusalError({
        status: 409,
        code: 'STATE_CHANGED',
        message: `The holders of mount '${mountpoint}' could not be listed again before the forced unmount — nothing was done; confirm again`,
      })
    }
    const added = listing.holders.filter(h => !listed.has(holderKey(h)))
    if (added.length === 0)
      return
    throw new GuardRefusalError({
      status: 409,
      code: 'STATE_CHANGED',
      message: `Mount '${mountpoint}' has holders the confirmation did not name (${added.map(holderLine).join(', ')}) — nothing was done; confirm again`,
    })
  }

  /** Stamp `heldByLun` onto every mount a LUN's image sits under. */
  async function annotateHeldByLun(rows: MountSummary[]): Promise<void> {
    if (rows.length === 0)
      return
    const cache = createIscsiClaimCache(executor, iscsiPaths)
    if ((await cache.claims()).length === 0)
      return
    for (const row of rows) {
      const held = await heldByLun(cache, { path: row.mountpoint })
      if (held)
        row.heldByLun = held
    }
  }

  /** AHR pin specs from the ANAS-managed mdadm.conf (empty when unconfigured). */
  async function readAhrSpecs(): Promise<Set<string>> {
    return mdadmConfPath ? ahrPinnedSpecs(await readMdadmConfText(mdadmConfPath)) : new Set<string>()
  }

  // --- GET /mounts — inventory --------------------------------------------
  server.get('/mounts', async () => {
    // cr3.mounts INVENTED-STATE-M10: the STRICT table read — an unreadable
    // table is `null`, and the rows say unknown (`buildInventory`), never
    // "not mounted"; the list itself says so too (`tableUnreadable`,
    // additive), because a mount that is not in fstab cannot be listed.
    const [findmntText, fstabText, pveMountPaths, ahrSpecs] = await Promise.all([
      readFindmntTable(executor),
      readConfig(fstabPath),
      // cr3.mounts follow-up (4): strict — an unreadable storage.cfg is null,
      // and every row says PVE ownership is unknown.
      readPveMountPathsStrict(storagePath ?? PVE_STORAGE_CFG),
      readAhrSpecs(),
    ])
    const rows = buildInventory(findmntText, fstabText, pveMountPaths, ahrSpecs)
    await probeInventoryHealth(executor, rows)
    // Story iscsi.6: which mounts a LUN's image file sits under, so Unmount and
    // Remove can be greyed with the reason attached. ONE claims read for the
    // whole grid; additive, so a mount nothing holds carries no field.
    await annotateHeldByLun(rows)
    return { data: rows, ...(findmntText === null ? { tableUnreadable: true } : {}) }
  })

  // --- GET /mounts/:mountpoint — detail (mountpoint is URL-encoded) --------
  server.get<{ Params: { mountpoint: string } }>('/mounts/:mountpoint', async (request, reply) => {
    const mp = parseMountpoint(request.params.mountpoint, reply)
    if (!mp)
      return
    const detail = await buildMountDetail(executor, mp, { fstabPath, credsDir, storagePath, mdadmConfPath })
    if (!detail) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Mount '${mp}' not found` } }
    }
    return { data: detail }
  })

  // --- POST /mounts — create (202 job) ------------------------------------
  server.post('/mounts', async (request, reply) => {
    const parsed = CreateMountRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid create mount request: ${zodIssue(parsed.error)}` } }
    }
    // The mountpoint is normalised at the boundary (the lock key's own
    // normaliser): `/mnt/x/` and `/mnt/x` are one directory, so the fstab
    // collision gates compare the same spelling and a second line for the
    // same directory is never written (cr.39 review).
    const req = { ...parsed.data, mountpoint: normalizeMountpointPath(parsed.data.mountpoint) }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Remote shares only (see remoteGate): a mount needs its server — and the
    // typed target is normalised at the boundary (the UI applies the same
    // normaliser): an empty server or an empty CIFS share comes back as a
    // guiding 400, never as a job that fails inside the kernel with a
    // malformed UNC (`//host/` → "CIFS: VFS: Malformed UNC in devname").
    const target = normalizeMountTarget(req.type, req)
    if (target.problems.length > 0) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: target.problems.join('; ') } }
    }

    // The request schema already validated `extraOptions`; this re-check turns
    // any wayward value at the daemon's write door into a 400 (cr.2 — defence
    // in depth, Principle 6) rather than an fstab line. THE entry is computed
    // up front because the create confirm binds the line this create writes
    // (cr.64b2): the entry IS the mount's identity, source + target + fstype.
    let entry: MountEntry
    let warnings: string[]
    try {
      ({ entry, warnings } = entryFromRequest(req, credsDir))
    }
    catch (err) {
      if (err instanceof InvalidExtraOptionsError) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Invalid extra mount options: ${err.message}` } }
      }
      throw err
    }

    // Story cr.39: the mountpoint-safety gates, run here and again in the job.
    const spec = createGuardSpec(req.mountpoint, { spec: entry.spec, target: entry.mountpoint, fstype: entry.fstype })
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    // Empty-dir / shadow check (L4, cr.52): §2 Mounts says "Mountpoint must be
    // an empty dir" — a non-empty directory honest with that ruling is refused
    // without a confirm by nothing; the CONFIRM is the explicit exception the
    // operator climbs over, and its sentence names the ruling so the two never
    // contradict (the panel's Proceed is the other story — cr.52 reports the
    // panel half's needs). The confirm is a guard door (cr.64b2), not the
    // legacy hand-picked-subset gate: the code signs the line the create
    // writes (the bound identity) and the WHOLE validated request — a replay
    // after the line changed is 409 IDENTITY_MISMATCH, a changed body is 409
    // CONFIRM_SCOPE_CHANGED naming the field.
    const listing = await dirContents(req.mountpoint)
    if (listing.state === 'unreadable' || (listing.state === 'listed' && listing.names.length > 0)) {
      // cr4.conf D-24: an unlistable folder asks for the SAME confirmation as
      // a visibly non-empty one — the failed read says nothing about what is
      // inside, and mounting over the folder hides it either way. The
      // sentence names the failed read and its error code, and ends with the
      // command that shows the operator what is in the folder.
      const found = listing.state === 'unreadable'
        ? `'${req.mountpoint}' could not be listed (${listing.code})`
        : `'${req.mountpoint}' is not empty`
      const hiding = listing.state === 'unreadable'
        ? 'whatever is inside it'
        : `the ${listing.names.length} item(s) already there`
      if (!guardConfirm(confirmStore, request, reply, spec, pre, {
        validated: {
          type: req.type,
          server: req.server,
          remotePath: req.remotePath,
          mountpoint: req.mountpoint,
          persistent: req.persistent,
          automount: req.automount,
          mountNow: req.mountNow,
          ...(req.options ? { options: req.options } : {}),
          ...(req.extraOptions !== undefined ? { extraOptions: req.extraOptions } : {}),
          // cr.66r (§2 Safety altitudes): a confirm signs the NAMES of every
          // field it writes, never a value — CIFS credentials are write-only
          // and the password must never ride the confirm store or the
          // CONFIRM_SCOPE_CHANGED sentence (describeField would JSON-echo the
          // whole object), so the code signs the sorted NAMES of the
          // credential fields present: a replay that adds or removes a field
          // re-challenges, one that rotates the password with the same fields
          // is the same request.
          ...(req.credentials ? { credentialFields: Object.keys(req.credentials).sort() } : {}),
        },
        address: ['mountpoint'],
        message: `${found} — a mountpoint must be an empty directory (§2 Mounts), so confirming will hide ${hiding}. Run ls -la ${req.mountpoint} as root to see what is in it before you confirm.`,
        warnings: [
          listing.state === 'unreadable'
            ? `${found} — the mount will hide whatever is inside it until unmounted.`
            : `'${req.mountpoint}' is not empty — the mount will hide its current contents until unmounted.`,
        ],
      })) {
        return reply
      }
    }

    const job = jobQueue.submit(
      'mount.create',
      { ...identity, params: { mountpoint: req.mountpoint } },
      // Ruling (j): every gate above runs again before the first act — for a
      // NON-persistent create too (the "already in /etc/fstab" refusal used to
      // be re-checked only inside the persistent path's fstab edit).
      guarded(spec, pre, async (_slot, { updateProgress }) => {
        updateProgress(`Creating mountpoint ${req.mountpoint}`)
        // cr.52s-c: the mountpoint is created THROUGH THE OPENED PARENT (the
        // pinned read-only-handle + O_NOFOLLOW open — `fs.constants.O_PATH` is
        // undefined on every node measured, see services/mounts.ts and
        // cr.52s-f F4 — plus the readlink proof, the leaf mkdir'd at
        // `/proc/self/fd/<fd>/<leaf>`) — never `mkdir(recursive)` on a textual
        // path a non-root user can re-point between this job's re-gate and the
        // mkdir (the old call followed every symlink it met and created
        // directories through a planted link as root).
        const { created: leafCreatedByThisJob } = await createMountpointThroughOpenedParent(req.mountpoint)

        // cr.52s-c restates cr.18 (review M7.2): the MOUNT runs before the
        // fstab line is written — a refused or failed mount leaves no line —
        // and every artifact this create wrote is removed again if a later
        // step fails. The credentials file lands just before the mount that
        // consumes it (the direct argv carries `credentials=<file>` and
        // mount.cifs reads the file AT mount time — the same reason the
        // mount-test probe writes its own temp creds file before the probe
        // mount), and goes again when the mount or the line fails.
        // cr.52s-f F8(d): the WRITE itself runs INSIDE the rollback try — a
        // write that fails (the atomic helper leaves no partial file) still
        // removes the leaf this job made, and reports through the same
        // sentence as any other failure, not a raw error over a stranded
        // directory.
        let credsFile: string | undefined
        let mounted = false
        try {
          if (req.type === 'cifs' && req.credentials && (req.persistent || req.mountNow)) {
            updateProgress('Writing credentials file')
            credsFile = await writeCredentialsFile(credsDir, req.mountpoint, req.credentials)
          }
          if (req.mountNow) {
            updateProgress(`Mounting ${req.mountpoint}`)
            // cr.52r D3: mount DIRECTLY from the entry through a directory the
            // daemon opened — persistently too, so the argv targets the fd- pinned
            // `/proc/self/fd/3` (the entry IS the line this create writes
            // below, so the mounted options are the line's own).
            await doMount(executor, entry, req.mountpoint)
            mounted = true
          }
          if (req.persistent) {
            updateProgress('Writing /etc/fstab entry')
            await editConfig(fstabPath, (current) => {
              if (hasMount(current, req.mountpoint))
                throw new Error(`Mount '${req.mountpoint}' is already in /etc/fstab`)
              return addMount(current, entry)
            })
          }
        }
        catch (err) {
          // No partial create: the mount this job ran is unmounted (checked),
          // the credentials file removed, and — cr.52s-f F3 — the mountpoint
          // leaf this job created is rmdir'd through its opened parent (never a
          // directory that already existed, never through a textual path; the
          // rmdir itself refuses a non-empty leaf, and nothing was mounted, so
          // the leaf is empty when we created it). The failure names the state
          // left behind — the invariant is that a refused or failed mount
          // leaves no fstab line, no credentials file, and no directory it
          // made.
          const reason = err instanceof Error ? err.message : String(err)
          const state: string[] = []
          let leftBehind: string | undefined
          if (mounted) {
            // cr.52s-f F8(a): a rollback umount that cannot even spawn (the
            // binary absent, the executor rejecting) is a FAILED rollback
            // exactly like a non-zero exit — caught HERE, so the credentials
            // removal and the leaf rmdir still run and the operator hears the
            // STILL MOUNTED clause with the thrown reason, never the raw
            // spawn error escaping the catch.
            try {
              const u = await executor.exec(UMOUNT, ['--', req.mountpoint])
              state.push(u.exitCode === 0
                ? `'${req.mountpoint}' was mounted by this job and has been unmounted`
                // A rollback unmount that itself failed is the one state the
                // operator must act on — say so, with the reason.
                : `'${req.mountpoint}' was mounted by this job and the rollback unmount FAILED (${cleanMountStderr(u.stderr) || `umount exited ${u.exitCode}`}) — it is left MOUNTED and must be unmounted by hand`)
            }
            catch (umountErr) {
              state.push(`'${req.mountpoint}' was mounted by this job and the rollback unmount FAILED (${umountErr instanceof Error ? umountErr.message : String(umountErr)}) — it is left MOUNTED and must be unmounted by hand`)
            }
          }
          if (credsFile !== undefined) {
            // cr.52s-f F8(b): the sentence says REMOVED only when the rm
            // actually did (`force: true` already covers the file being gone
            // before the rollback ran); a real failure names the secret left
            // on disk instead of claiming the opposite.
            const rmFailure = await rm(credsFile, { force: true })
              .then(() => null)
              .catch((e: unknown) => (e as NodeJS.ErrnoException).code ?? String(e))
            state.push(rmFailure === null
              ? 'the credentials file was removed'
              : `the credentials file '${credsFile}' could not be removed (${rmFailure}) and is left on disk`)
          }
          if (leafCreatedByThisJob) {
            const whyLeft = await removeMountpointLeafThroughOpenedParent(req.mountpoint)
            if (whyLeft === null)
              state.push(`'${req.mountpoint}' was created by this job and has been removed again`)
            else
              leftBehind = whyLeft
          }
          // The closing clause: the directory this job made is gone, so the
          // sentence stays the plain one — but if the rmdir failed, the
          // directory is NAMED as the thing left behind instead (the operator
          // must remove it by hand; an empty directory is harmless, and
          // naming it is why "Nothing else was written" stays true elsewhere).
          const closing = leftBehind === undefined
            ? `Nothing else was written${req.persistent ? ' (no /etc/fstab line)' : ''}`
            : `The mountpoint directory '${req.mountpoint}' was created by this job and its removal failed (${leftBehind}) — it is left behind and must be removed by hand${req.persistent ? '; no /etc/fstab line was written' : ''}`
          throw new Error(`Mount create '${req.mountpoint}' failed — ${[reason, ...state].join('; ')}. ${closing}`)
        }
        if (req.persistent) {
          // The reload follows the WRITTEN line. A failed reload leaves the
          // line (the config is the state) and the live mount — only systemd's
          // units are stale — so nothing rolls back here (the documented
          // decision). cr.52s-f F8(c): the job failure then NAMES that
          // surviving state — what is up, where the line is, what to run —
          // instead of throwing the raw reload error out of the job.
          updateProgress('Reloading systemd (daemon-reload)')
          try {
            await daemonReload(executor)
          }
          catch (reloadErr) {
            const why = reloadErr instanceof Error ? reloadErr.message : String(reloadErr)
            const survivors: string[] = []
            if (mounted)
              survivors.push(`the mount is up at '${req.mountpoint}'`)
            survivors.push(`the line is written in ${fstabPath}`)
            // The credentials file survives too (the line references it) —
            // named, as the rollback path names it (cr.52s-f review).
            if (credsFile !== undefined)
              survivors.push(`the credentials file '${credsFile}' is in place`)
            survivors.push('systemd\'s units are stale — run \'systemctl daemon-reload\'')
            throw new Error(`Mount create '${req.mountpoint}' failed — ${[why, ...survivors].join('; ')}; nothing was rolled back`)
          }
        }
        // cr3.mounts L11: a NON-persistent mount has no line to name its
        // credentials file, and mount.cifs read it at mount time (the kernel
        // keeps the session's secret) — so the file goes now. Left on disk it
        // was a secret nothing referenced and no Remove ever deleted.
        if (!req.persistent && credsFile !== undefined) {
          const rmFailure = await rm(credsFile, { force: true }).then(() => null, (e: unknown) => (e as NodeJS.ErrnoException).code ?? String(e))
          if (rmFailure !== null)
            warnings.push(`The credentials file '${credsFile}' of this session mount could not be removed (${rmFailure}) — remove it by hand`)
        }
        return { created: req.mountpoint, warnings }
      }),
      // Story cr.39: one mount verb at a time per mountpoint.
      { locks: pre.locks },
    )

    reply.code(202)
    return { job }
  })

  // --- PUT /mounts/:mountpoint — edit options / rotate credentials --------
  server.put<{ Params: { mountpoint: string } }>('/mounts/:mountpoint', async (request, reply) => {
    const mp = parseMountpoint(request.params.mountpoint, reply)
    if (!mp)
      return

    const parsed = UpdateMountRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid update mount request: ${zodIssue(parsed.error)}` } }
    }
    const body = parsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // PVE, AHR, the line exists, remote only, and (ident.4 (e): the edit
    // remounts) never another filesystem at the target. Story cr.39: the line's
    // revision is bound — the job writes a merge of THIS line or nothing.
    const spec = mountGuardSpec(mp, 'update')
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const existing = pre.object.entry as MountEntry // the line-exists gate passed
    // cr3.mounts M5: credentials belong to a CIFS line. Sent for any other
    // (an NFS line), they used to be written to a credentials file the line
    // never names — an orphaned secret and a job that said it rotated.
    if (body.credentials && !isCifs(existing.fstype)) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Mount '${mp}' is ${existing.fstype}, not CIFS — credentials apply to CIFS mounts only, and nothing was written` } }
    }

    // `mergeEntry` re-validates a SUPPLIED `extraOptions` at this write door
    // (cr.2 — defence in depth, Principle 6); a wayward value is a 400.
    // cr3.mounts L12 (review fix 1): the dialog shows a credentials FILE's
    // domain in its Domain field when the line carries none; echoed back as
    // `options.domain` it would add `domain=` to a line nobody edited. A
    // domain equal to the one the line's own credentials file already gives
    // is the file's, not an edit of the line: kept off it.
    // cr3.mounts review 3 (10): a file that cannot be read is UNKNOWN, never
    // "no credentials" — its domain may be the one the dialog shows, so the
    // edit keeps the line's credential tokens as they are (domain kept off).
    let options = body.options
    if (typeof options?.domain === 'string' && isCifs(existing.fstype) && existing.options.cifs?.domain === undefined && existing.credentialsFile) {
      const fileDomain = await readCredentialsSecrets(existing.credentialsFile).then(c => c?.domain ?? null, () => undefined)
      if (fileDomain === undefined || fileDomain === options.domain) {
        const { domain: _fromFile, ...rest } = options
        options = rest
      }
    }
    let merged: MountEntry
    try {
      merged = mergeEntry(existing, options, body.automount, body.extraOptions)
    }
    catch (err) {
      if (err instanceof InvalidExtraOptionsError) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Invalid extra mount options: ${err.message}` } }
      }
      throw err
    }
    // SECURITY (BUG-1): a hand-written entry with inline plaintext credentials is
    // MIGRATED on this operator-initiated save — the secret moves to the protected
    // 0600 creds file and the rewritten fstab line carries `credentials=<file>`
    // with NO inline username/password/domain.
    // cr.60r (the review's DEFECT): there is something to migrate only when the
    // line carries a PASSWORD. A username-only line has none, and moving it is
    // not the alternative — an empty `password=` in a creds file is a real
    // credential shape (an empty password / a prompt) and would CHANGE the
    // mount. So the username stays where it is: the serializer re-emits the
    // `user=` token (never `guest`), and the line keeps the account it named.
    // cr3.mounts review 2: an inline ALTERNATE password (`password2=`/`pass2=`)
    // is migrated exactly like the password (mount.cifs reads it from the
    // credentials file too).
    const migrating = existing.inlineCredentials?.password !== undefined || existing.inlineCredentials?.password2 !== undefined
    // cr3.mounts review 3: the migration's content is decided before anything
    // is done — at the route (a 400) and again in the job.
    if (migrating && !body.credentials) {
      const plan = await migrationPlan(existing, pre.object.fstabText)
      if ('refusal' in plan) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', reason: 'migration-refused', message: plan.refusal } }
      }
    }

    const job = jobQueue.submit(
      'mount.update',
      // The changed options ride the audit entry: a live diagnosis of "the edit
      // completed but nothing changed" (issue #25) had only the mountpoint to go on.
      { ...identity, params: { mountpoint: mp, ...(body.options ? { options: body.options } : {}) } },
      // Ruling (j): id, the line's revision and every gate (the foreign mount
      // check among them, right before anything is written) run again here.
      guarded(spec, pre, async (o, { updateProgress }) => {
        // VALIDATE-THEN-COMMIT (issue #24): the new secret is proven against the
        // server BEFORE anything is written. Nothing below this point runs on a
        // rejected password, so the live creds file and fstab stay untouched.
        // cr3.mounts L12 (review fix 5): a save that changes nothing — the
        // merged line says exactly what the stored line says (the forced
        // `nofail` aside), no credentials sent, nothing to migrate — does
        // NOTHING: no fstab write, no daemon-reload, and no remount (which
        // used to unmount a live share under its holders, or mount an
        // unmounted `noauto` line). The result says so.
        if (!body.credentials && !migrating && sameLine(existing, merged)) {
          updateProgress('Nothing to change')
          return { updated: mp, unchanged: true, message: `Nothing changed — the /etc/fstab line of '${mp}' already says this; the line and the mount were left as they are.` }
        }
        const editWarnings: string[] = []
        // cr3.mounts review 3 (6): the credentials file this job may write is
        // the mount's hashed ANAS file. What was there BEFORE is kept, so a
        // failed /etc/fstab write puts it back (or removes the file this job
        // made) — a copy of a password is never left behind by a failure.
        const ownFile = credsFilePath(credsDir, mp)
        // null: there was no file; undefined: one that could not be read —
        // only a rotation with typed credentials goes on over it (review 3
        // (3): rotation is the way out of a broken file). Kept as BYTES and
        // put back as bytes (review 4, N3). Read only when this Save writes
        // the file (review 4, N9): an option-only Save never needs it.
        let ownBefore: Buffer | null | undefined = null
        if (body.credentials || migrating) {
          try {
            ownBefore = await readFile(ownFile)
          }
          catch (err) {
            const code = (err as NodeJS.ErrnoException).code
            // ENOTDIR: what is in the creds directory's place is not a
            // directory, so no such file exists (the write then says why).
            if (code === 'ENOENT' || code === 'ENOTDIR')
              ownBefore = null
            else if (body.credentials)
              ownBefore = undefined
            else
              throw new Error(`Could not read the credentials file '${ownFile}' before writing it (${code ?? String(err)}) — nothing was changed`)
          }
        }
        // What the line said before (for the backup scrub, review 4 N1).
        const oldRaw = parseFstabDoc(o.fstabText).find(l => l.kind === 'entry' && l.entry.mountpoint === mp)?.raw
        let wroteOwnFile = false
        if (body.credentials) {
          // cr3.mounts review 3 (3): a rotation with the full new credentials
          // TYPED is the way out of a broken file — it proceeds whether or not
          // the old file can be read. The old account's alternate password is
          // carried over only when it can be read and the username is the
          // same; otherwise the result says it was not.
          const carry = await alternatePasswordToCarry(existing, o.fstabText, body.credentials.username)
          editWarnings.push(...carry.notes)
          updateProgress('Validating credentials')
          const rotated = await rotateCredentialsFile(executor, credsDir, merged, {
            ...body.credentials,
            ...(carry.password2 !== undefined ? { password2: carry.password2 } : {}),
          })
          wroteOwnFile = true
          merged.credentialsFile = rotated.path
          if (rotated.warning)
            editWarnings.push(rotated.warning)
        }
        else if (migrating) {
          // Operator did NOT retype the password: seed the creds file from the
          // EXTRACTED inline secret (one-time migration) so the mount keeps working
          // with its real password (specials like '#' preserved via the line-based
          // creds format). The plaintext never returns to the fstab line.
          // cr3.mounts reviews 2/3: the account written is the one mount.cifs
          // used — the line's inline tokens and (when it is ANAS's own) the
          // file it names, by mount.cifs' precedence (migrationPlan).
          const plan = await migrationPlan(existing, o.fstabText)
          if ('refusal' in plan)
            throw new Error(plan.refusal)
          updateProgress('Migrating inline credentials to a protected file')
          merged.credentialsFile = await writeCredentialsFile(credsDir, mp, plan.content)
          wroteOwnFile = true
        }
        // cr.60r: rotated credentials REPLACE the line's inline identity too —
        // the new file names the account, so a username-only line's `user=bob`
        // must not ride on beside it (the pre-cr.60r save dropped it here; only
        // a save that leaves the credentials alone keeps the token).
        if (migrating || (body.credentials && existing.inlineCredentials?.username !== undefined)) {
          // Drop the inline tokens from the serialized entry (the serializer
          // re-emits a lifted username, cr.60r; also drop the now-migrated domain
          // option so it is not re-emitted inline).
          delete merged.inlineCredentials
          if (merged.options.cifs)
            delete merged.options.cifs.domain
        }
        // cr3.mounts L12 (§2 dialog contract: "an untouched edit rewrites
        // byte-identically"): a save that changes nothing the line says —
        // no option, no credential, nothing to migrate — leaves the line's
        // bytes alone. A rewrite canonicalises a hand-written line (spacing,
        // token order, `nfsvers=` → `vers=`), which is not the operator's
        // edit. The forced `nofail` is ANAS's rule for the lines it writes;
        // on its own it is not a reason to rewrite a line nobody edited.
        updateProgress('Rewriting /etc/fstab entry')
        try {
          await editConfig(fstabPath, (current) => {
            if (!hasMount(current, mp))
              throw new Error(`Mount '${mp}' is not in /etc/fstab`)
            // cr4.conf D-21 last-moment backstop: a second line appeared since
            // the gate read — refuse, the file keeps its bytes.
            const dup = duplicateFstabLines(current, mp)
            if (dup)
              throw new GuardRefusalError(dup)
            return replaceMount(current, mp, merged)
          })
        }
        catch (err) {
          const why = err instanceof Error ? err.message : String(err)
          if (!wroteOwnFile)
            throw err
          // cr3.mounts review 3 (6): undo only what this job did to the file.
          const holds = body.credentials ? 'the new credentials (already tested against the server)' : 'the credentials migrated from the line'
          if (ownBefore === undefined)
            throw new Error(`Rewriting /etc/fstab failed (${why}) — the credentials file '${ownFile}' now holds ${holds} (what it held before could not be read, so it could not be put back); /etc/fstab was not changed`)
          const undo = ownBefore === null
            ? await rm(ownFile, { force: true }).then(() => null, (e: unknown) => (e as NodeJS.ErrnoException).code ?? String(e))
            : await restoreFileBytes(ownFile, ownBefore, 0o600).then(() => null, (e: unknown) => (e as NodeJS.ErrnoException).code ?? String(e))
          // review 4 (D2): when the line ALREADY named this file, deleting it
          // would break the next mount — say what it holds now instead.
          const fileClause = undo === null
            ? (ownBefore === null ? `the credentials file '${ownFile}' this job wrote was removed again` : `the credentials file '${ownFile}' was put back as it was`)
            : ownBefore !== null && existing.credentialsFile === ownFile
              ? `the credentials file '${ownFile}' this line names could not be put back (${undo}) and now holds ${holds} — leave it in place: the line still names it`
              : `the credentials file '${ownFile}' this job wrote could not be ${ownBefore === null ? 'removed' : 'put back'} (${undo}) and must be removed by hand`
          throw new Error(`Rewriting /etc/fstab failed (${why}) — ${fileClause}; /etc/fstab was not changed`)
        }
        // cr3.mounts review 4 (N1): the writer's backup (`<fstab>.bak`, the
        // file as it was before this edit) still holds the secret this Save
        // moved out of the line — scrubbed (the migrated line takes its place).
        if (migrating && oldRaw !== undefined) {
          const newRaw = parseFstabDoc(await readConfig(fstabPath)).find(l => l.kind === 'entry' && l.entry.mountpoint === mp)?.raw ?? null
          const left = await scrubFstabBackup(oldRaw, newRaw, existing)
          if (left)
            editWarnings.push(left)
        }
        // A rotation writes the hashed name (ident.4 (d)); the file the line
        // named before (a pre-ident.4 flattened name) goes once nothing
        // references it — and only from the ANAS creds directory.
        if (existing.credentialsFile && merged.credentialsFile && existing.credentialsFile !== merged.credentialsFile) {
          const left = await removeCredentialsFileIfUnreferenced(credsDir, existing.credentialsFile, await readConfig(fstabPath))
          if (left)
            editWarnings.push(left)
        }
        updateProgress('Reloading systemd (daemon-reload)')
        await daemonReload(executor)
        updateProgress(`Remounting ${mp}`)
        await remountEntry(executor, merged)
        return { updated: mp, ...(editWarnings.length > 0 ? { warnings: editWarnings } : {}) }
      }),
      { locks: pre.locks },
    )

    reply.code(202)
    return { job }
  })

  // --- POST /mounts/:mountpoint/state — mount/unmount (keep fstab entry) ---
  server.post<{ Params: { mountpoint: string } }>('/mounts/:mountpoint/state', async (request, reply) => {
    const mp = parseMountpoint(request.params.mountpoint, reply)
    if (!mp)
      return

    const parsed = MountStateRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid mount state request: ${zodIssue(parsed.error)}` } }
    }
    const { action } = parsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Story cr.39: PVE, AHR, remote only, the foreign-mount check (not for
    // enable, which touches fstab alone), the verb's state, and — for unmount
    // and disable — held by a LUN (iscsi.6: BEFORE the busy confirm, since the
    // busy confirm offers a lazy unmount, precisely the wrong answer to a LUN).
    const spec = mountGuardSpec(mp, action)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    // --- mount: bring it up (keep the fstab entry) ---
    if (action === 'mount') {
      const job = jobQueue.submit(
        'mount.mount',
        { ...identity, params: { mountpoint: mp } },
        guarded(spec, pre, async (o, { updateProgress }) => {
          updateProgress(`Mounting ${mp}`)
          // cr.52r D3: mounted DIRECTLY from the line the job re-read, through
          // the fd-pinned directory (the kernel resolves `/proc/self/fd/3`).
          if (!o.entry)
            throw new Error(`Mount '${mp}' is not configured in /etc/fstab — nothing to mount`)
          await doMount(executor, o.entry, mp)
          return { mounted: mp }
        }),
        { locks: pre.locks },
      )
      reply.code(202)
      return { job }
    }

    // --- enable: remove exactly what disable added (config inverse; no mount) ---
    if (action === 'enable') {
      const job = jobQueue.submit(
        'mount.enable',
        { ...identity, params: { mountpoint: mp } },
        guarded(spec, pre, async (_o, { updateProgress }) => {
          updateProgress(`Enabling ${mp} in /etc/fstab`)
          await editConfig(fstabPath, (current) => {
            // cr4.conf D-21 last-moment backstop: two lines for the mountpoint
            // appeared since the gate read — refuse, the file keeps its bytes.
            const dup = duplicateFstabLines(current, mp)
            if (dup)
              throw new GuardRefusalError(dup)
            return enableMount(current, mp)
          })
          updateProgress('Reloading systemd (daemon-reload)')
          await daemonReload(executor)
          return { enabled: mp }
        }),
        { locks: pre.locks },
      )
      reply.code(202)
      return { job }
    }

    // --- disable / unmount both unmount first ---
    // The confirm (cr.39): a busy mount (holders → a forced lazy unmount) and
    // anything riding the path (shares, exports, backup/cloud tasks, a nested
    // mount — warn, never refuse) are both said before anything is done. An
    // UNKNOWN holder listing (D3: neither lsof nor fuser answered) also
    // confirms — the confirm says the holders could not be listed, never that
    // there are none, and the unmount is not forced on an unknowable set.
    // nf.3 D10: the holder set shown is BOUND into the code (`confirmScope`),
    // so a resend that lists other holders — one that opened a file since the
    // challenge — is 409 CONFIRM_SCOPE_CHANGED naming them, never a detach of
    // a process the operator was not shown; the job compares against that set.
    const disabling = action === 'disable'
    const verbing = VERBING[action]
    const listing = pre.object.mounted ? await listHolders(executor, mp, procRoot) : null
    const holders = listing?.state === 'listed' ? listing.holders : []
    const holdersUnknown = listing?.state === 'unknown'
    if (holders.length > 0 || holdersUnknown || pre.advisories.length > 0) {
      if (!guardConfirm(confirmStore, request, reply, spec, pre, {
        validated: { mountpoint: mp, action },
        address: ['mountpoint'],
        confirmScope: { holders: boundHolders(listing) },
        message: holders.length > 0
          ? `'${mp}' is busy — ${holders.length} process(es) are holding it`
          : holdersUnknown
            ? `'${mp}' may be busy — its holders could not be listed`
            : `${verbing} '${mp}' affects what is configured on it`,
        warnings: [...busyWarnings(mp, holders, holdersUnknown), ...pre.advisories.map(a => a.warning)],
      })) {
        return reply
      }
    }
    const lazy = holders.length > 0 // confirmed: the set the code bound (D10)

    const job = jobQueue.submit(
      `mount.${action}`,
      { ...identity, params: { mountpoint: mp } },
      // Ruling (j): id, every gate (held by a LUN among them) and the
      // references run again here, against what the node has now.
      guarded(spec, pre, async (o, ctx) => {
        const { updateProgress } = ctx
        if (o.mounted) {
          if (lazy)
            await assertNoNewHolders(mp, holders)
          updateProgress(`Unmounting ${mp}${lazy ? ' (lazy)' : ''}`)
          const r = await executor.exec(UMOUNT, lazy ? ['-l', mp] : [mp])
          if (r.exitCode !== 0)
            throw new Error(await unmountFailure(r, mp, lazy))
        }
        // Story cr.24/cr.39: references that appeared after the confirm.
        const warnings = [...ctx.newAdvisories]
        if (disabling) {
          // Append `noauto,x-anas.disabled` (or the kept-noauto token over the
          // operator's own noauto) to the fstab line and park its automount;
          // KEEP the credentials file.
          updateProgress(`Disabling ${mp} in /etc/fstab`)
          let automount = false
          await editConfig(fstabPath, (current) => {
            // cr4.conf D-21 last-moment backstop: two lines for the mountpoint
            // appeared since the gate read — refuse, the file keeps its bytes.
            const dup = duplicateFstabLines(current, mp)
            if (dup)
              throw new GuardRefusalError(dup)
            automount = carriesAutomount(current, mp) // the line BEFORE the change
            return disableMount(current, mp)
          })
          warnings.push(...await stopAutomountIf(automount, mp, updateProgress))
          updateProgress('Reloading systemd (daemon-reload)')
          await daemonReload(executor)
          return { disabled: mp, ...(warnings.length > 0 ? { warnings } : {}) }
        }
        return { unmounted: mp, ...(warnings.length > 0 ? { warnings } : {}) }
      }),
      { locks: pre.locks },
    )
    reply.code(202)
    return { job }
  })

  // --- DELETE /mounts/:mountpoint — unmount + drop entry ------------------
  server.delete<{ Params: { mountpoint: string }, Querystring: { removeMountpointDir?: string } }>('/mounts/:mountpoint', async (request, reply) => {
    const mp = parseMountpoint(request.params.mountpoint, reply)
    if (!mp)
      return

    // Opt-in tidy-up (18.5 refinement): also rmdir the now-empty mountpoint
    // directory. Absent ⇒ false, normalised before the confirm signs it.
    const query = DeleteMountQuery.safeParse(request.query ?? {})
    if (!query.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid delete mount query: ${zodIssue(query.error)}` } }
    }
    const { removeMountpointDir } = query.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // PVE, AHR, exists, remote only, ident.4 (e) (a failed CIFS line whose
    // target now carries a local filesystem must not take that filesystem
    // down with it), held by a LUN (iscsi.6: remove unmounts first) — at the
    // route and again in the job.
    const spec = mountGuardSpec(mp, 'remove')
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const { entry, mounted } = pre.object
    const credentialsFile = credentialsFileOf(pre.object)
    const listing = mounted ? await listHolders(executor, mp, procRoot) : null
    const holders = listing?.state === 'listed' ? listing.holders : []
    const holdersUnknown = listing?.state === 'unknown'

    // Story cr.39 (WAVE3-DESIGN §2.5, §5.2): a remove ALWAYS confirms — it
    // deletes the line, the credentials file and (opted in) the directory —
    // and the code signs the whole request (`removeMountpointDir`), the
    // mount's spec + type, and the credentials file it deletes. Anything riding
    // the path is listed (warn, never refuse).
    const warnings = [
      ...(entry ? [`The /etc/fstab line for '${mp}' is deleted; the mount does not come back at boot.`] : []),
      ...(mounted ? [`'${mp}' is unmounted now.`] : []),
      ...(credentialsFile ? [`The credentials file ${credentialsFile} is deleted if it exists and no other /etc/fstab line names it.`] : []),
      ...(removeMountpointDir ? [`The mountpoint directory '${mp}' is removed if it is empty (never its contents).`] : []),
      ...busyWarnings(mp, holders, holdersUnknown),
      ...pre.advisories.map(a => a.warning),
    ]
    // nf.3 D10: the holders shown are bound, as for unmount and disable.
    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { mountpoint: mp, removeMountpointDir },
      address: ['mountpoint'],
      confirmScope: { holders: boundHolders(listing) },
      message: holders.length > 0
        ? `'${mp}' is busy — ${holders.length} process(es) are holding it`
        : `Removing mount '${mp}' deletes its configuration`,
      warnings,
    })) {
      return reply
    }
    const lazy = holders.length > 0 // confirmed: the set the code bound (D10)

    const job = jobQueue.submit(
      'mount.remove',
      { ...identity, params: { mountpoint: mp, ...(removeMountpointDir ? { removeMountpointDir } : {}) } },
      // Ruling (j): id, the bound credentials file, every gate and the
      // references run again against what the node has now.
      guarded(spec, pre, async (o, ctx) => {
        const { updateProgress } = ctx
        const resultWarnings: string[] = [...ctx.newAdvisories]
        if (o.mounted) {
          if (lazy)
            await assertNoNewHolders(mp, holders)
          updateProgress(`Unmounting ${mp}${lazy ? ' (lazy)' : ''}`)
          const r = await executor.exec(UMOUNT, lazy ? ['-l', mp] : [mp])
          if (r.exitCode !== 0)
            throw new Error(await unmountFailure(r, mp, lazy))
        }
        if (o.entry) {
          updateProgress('Removing /etc/fstab entry')
          let automount = false
          await editConfig(fstabPath, (current) => {
            // cr4.conf D-21 last-moment backstop: two lines for the mountpoint
            // appeared since the gate read — refuse, the file keeps its bytes.
            const dup = duplicateFstabLines(current, mp)
            if (dup)
              throw new GuardRefusalError(dup)
            automount = carriesAutomount(current, mp) // the line BEFORE the change
            return removeMount(current, mp)
          })
          resultWarnings.push(...await stopAutomountIf(automount, mp, updateProgress))
          updateProgress('Reloading systemd (daemon-reload)')
          await daemonReload(executor)
        }
        // cr3.mounts review 4 (N1): a removed line that carried an inline
        // secret leaves it in the writer's backup — scrubbed the same way.
        if (o.entry && carriesInlineSecret(o.entry)) {
          const oldRaw = parseFstabDoc(o.fstabText).find(l => l.kind === 'entry' && l.entry.mountpoint === mp)?.raw
          const left = oldRaw === undefined ? undefined : await scrubFstabBackup(oldRaw, null, o.entry)
          if (left)
            resultWarnings.push(left)
        }
        // The file the confirm named (the scope check above proved it still is
        // the one); removed only from the creds dir and only when no other line
        // references it — decided on the fstab as it is after the line is gone.
        const file = credentialsFileOf(o)
        const fstabAfter = await readConfig(fstabPath)
        if (file) {
          updateProgress('Removing credentials file')
          const kept = await removeCredentialsFileIfUnreferenced(credsDir, file, fstabAfter)
          if (kept)
            resultWarnings.push(kept)
        }
        // cr3.mounts review 4 (N7): ANAS's own leftovers for THIS mountpoint
        // go too — a stale rotation candidate (`.<hashed>.validating`, never
        // referenced) and an orphaned hashed credentials file no line names.
        // Only files of ANAS's own name pattern in ANAS's own directory.
        const hashed = credsFilePath(credsDir, mp)
        if (hashed !== file) {
          const kept = await removeCredentialsFileIfUnreferenced(credsDir, hashed, fstabAfter)
          if (kept)
            resultWarnings.push(kept)
        }
        const candidate = join(credsDir, `.${credsFileName(mp)}.validating`)
        const leftCandidate = await rm(candidate, { force: true }).then(() => null, (e: unknown) => (e as NodeJS.ErrnoException).code ?? String(e))
        if (leftCandidate !== null)
          resultWarnings.push(`A stale credentials candidate '${candidate}' could not be removed (${leftCandidate}) — remove it by hand.`)
        if (removeMountpointDir) {
          // rmdir semantics only, and only once the mount is really gone. A
          // directory that will not go (not empty, still held) NEVER fails the
          // delete the user asked for — it rides the result as a warning.
          updateProgress(`Removing the mountpoint directory ${mp}`)
          // cr3.mounts L14: the directory the opt-in removes is the line's
          // TEXTUAL mountpoint — a hand-written line can name `/srv`, `/home`
          // or `/mnt`. A path the mount-target rule protects, or a top-level
          // directory of the root filesystem, is never removed (even empty):
          // left in place and said.
          const protectedPath = await mountTargetRefusal(mp)
          const left = protectedPath !== null
            ? `The directory '${mp}' was left in place — ANAS never removes a path the mount-target rule refuses (${protectedPath.message}).`
            : isTopLevelDir(mp)
              ? `The directory '${mp}' was left in place — it is a top-level directory of the root filesystem.`
              : await removeEmptyMountpointDir(mp, await isMounted(mp))
          if (left)
            resultWarnings.push(left)
        }
        return { removed: mp, ...(resultWarnings.length > 0 ? { warnings: resultWarnings } : {}) }
      }),
      { locks: pre.locks },
    )

    reply.code(202)
    return { job }
  })

  // --- POST /mounts/test — synchronous preflight diagnosis ----------------
  server.post('/mounts/test', async (request, reply) => {
    const parsed = MountTestRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid mount test request: ${zodIssue(parsed.error)}` } }
    }
    const identity = requireIdentity(request, reply)
    if (!identity)
      return
    // The typed target is normalised BEFORE any DNS/port/mount stage: an empty
    // server or CIFS share is a guiding 400 — it used to sail through to the
    // probe, fail the kernel's UNC parse (`mount error(22)`), and come back
    // "unreachable — no route to the server".
    const target = normalizeMountTarget(parsed.data.type, parsed.data)
    if (target.problems.length > 0) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: target.problems.join('; ') } }
    }
    // cr3.mounts L9: the Edit dialog tests an existing CIFS mount with the
    // credentials its line already carries (it is never shown the password,
    // so it cannot send it). Only that line's own share is probed with them:
    // stored credentials are never offered to another server.
    let stored: StoredProbeCredentials = {}
    if (parsed.data.mountpoint !== undefined && parsed.data.type === 'cifs' && !parsed.data.credentials) {
      const mp = parsed.data.mountpoint
      const fstabText = await readConfig(fstabPath)
      const entry = getMount(fstabText, mp)
      if (!entry || !isCifs(entry.fstype)) {
        reply.code(404)
        return { error: { code: 'NOT_FOUND', message: `Mount '${mp}' is not a CIFS line in /etc/fstab — there are no stored credentials to test with` } }
      }
      if (buildSpec('cifs', target) !== buildSpec('cifs', parseSpec('cifs', entry.spec))) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `The stored credentials of '${mp}' are tested only against its own share (${entry.spec}) — nothing was probed` } }
      }
      // cr3.mounts review 4 (N8): test what the MOUNT uses — one account path
      // (effectiveCifsAccount), the line's own user/domain/password tokens
      // over the file by mount.cifs' precedence. A line whose credential
      // tokens ANAS cannot read (an escaped separator, several files) is not
      // tested as something else.
      const scan = cifsCredentialTokenScan(fstabText, mp)
      if (entry.escapedSeparatorTokens?.length || (scan?.files ?? 0) > 1) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `The /etc/fstab line of '${mp}' has options ANAS cannot read the way mount.cifs does (an escaped ',' or '=', or more than one credentials file), so Test cannot tell which account the mount uses — fix the line on the node, or type the credentials to test them` } }
      }
      const inl = entry.inlineCredentials
      const lineSaysAccount = inl?.username !== undefined || inl?.domain !== undefined || inl?.password !== undefined || inl?.password2 !== undefined
      if (entry.credentialsFile && !lineSaysAccount) {
        stored = { credentialsFile: entry.credentialsFile }
      }
      else {
        let file: Partial<CredentialsFileContent> | null = null
        if (entry.credentialsFile) {
          try {
            file = await readCredentialsSecrets(entry.credentialsFile)
          }
          catch (err) {
            reply.code(400)
            const why = err instanceof CredentialsFileUninterpretableError ? err.message : `the credentials file '${entry.credentialsFile}' could not be read (${(err as NodeJS.ErrnoException).code ?? String(err)})`
            return { error: { code: 'VALIDATION_ERROR', message: `Test cannot use the stored credentials of '${mp}': ${why} — type the credentials to test them` } }
          }
        }
        const account = effectiveCifsAccount(entry, fstabText, file)
        // (review fix 3) a user with no password anywhere cannot be tested as
        // that user: a guest probe would answer for an identity the line does not use.
        if (account.password === undefined && account.username) {
          reply.code(400)
          return { error: { code: 'VALIDATION_ERROR', message: `The /etc/fstab line of '${mp}' names the user '${account.username}' but no password or credentials file, so Test cannot prove that identity — type the password to test it` } }
        }
        if (account.password !== undefined && !account.username) {
          reply.code(400)
          return { error: { code: 'VALIDATION_ERROR', message: `The /etc/fstab line of '${mp}' keeps a password but names no username, so Test cannot tell which account the mount uses — type the credentials to test them` } }
        }
        if (account.password !== undefined) {
          stored = {
            inline: {
              username: account.username ?? '',
              password: account.password,
              ...(account.password2 !== undefined ? { password2: account.password2 } : {}),
              ...(account.domain !== undefined ? { domain: account.domain } : {}),
            },
          }
        }
      }
      if (entry.options.cifs?.vers !== undefined)
        stored.vers = entry.options.cifs.vers
    }
    try {
      const result = await runMountTest(executor, parsed.data, mountTestStages, stored)
      return { data: result }
    }
    catch (err) {
      // cr3.mounts review 2 (5): the probe's private directory could not be
      // made — a 503 naming it, never a raw errno 500.
      if (err instanceof ProbeRuntimeDirError) {
        reply.code(503)
        return { error: { code: 'UNAVAILABLE', message: err.message } }
      }
      throw err
    }
  })

  // --- helpers ------------------------------------------------------------

  /**
   * cr.19 (§2 Mounts automount ruling; node pass R1-D2/D3): after Disable or
   * Remove has edited a line that carried an automount (live or parked), stop
   * its `.automount` unit BEFORE the daemon-reload — the reload alone leaves an
   * armed automount armed, and a removed line's placeholder orphaned. A plain
   * line runs no stop. A failed stop is a warning on the job result: the fstab
   * edit already happened, so it is never a job failure, and never swallowed.
   */
  async function stopAutomountIf(automount: boolean, mountpoint: string, updateProgress: (msg: string) => void): Promise<string[]> {
    if (!automount)
      return []
    updateProgress(`Stopping the automount unit for ${mountpoint}`)
    const warning = await stopAutomountUnit(executor, mountpoint)
    return warning ? [warning] : []
  }

  /**
   * The job failure of an unmount that did not happen. cr3.mounts L16: a
   * FORCED (lazy) unmount that fails is a failure too — it used to be
   * ignored, and the job went on to report the mount disabled or removed
   * (Remove deleting the credentials file) while it was still mounted. It
   * fails before anything else is changed, and says so.
   */
  async function unmountFailure(r: ExecResult, mp: string, lazy: boolean): Promise<string> {
    const why = r.stderr.trim() || `umount exited ${r.exitCode}`
    if (lazy)
      return `The forced (lazy) unmount of '${mp}' failed (${why}) — it is still mounted, and nothing else was changed`
    return enrichBusyError(executor, why, mp, configfsOptionsFrom(iscsiPaths))
  }

  /**
   * Is the mountpoint currently in the kernel mount table? An UNREADABLE
   * table answers true (cr3.mounts: a read that failed never reads as
   * "not mounted") — the one caller then leaves the directory in place.
   */
  async function isMounted(mountpoint: string): Promise<boolean> {
    const table = await readFindmntTable(executor)
    return table === null || mountedIn(table, mountpoint)
  }

  /** Parse + validate a URL-encoded mountpoint param, or 400 and return null. */
  function parseMountpoint(raw: string, reply: FastifyReply): string | null {
    const parsed = AbsolutePath.safeParse(raw)
    if (!parsed.success) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Invalid mountpoint: ${zodIssue(parsed.error)}` } })
      return null
    }
    return parsed.data
  }
}

/**
 * cr3.mounts (from the AHR review): a remote share is never placed at or under
 * the base ANAS Hybrid RAID pools mount at (`/mnt/anas-ahr`, or the
 * `ANAS_AHR_MOUNT_BASE` override) — that tree is AHR's: a share there is a
 * second way into an AHR create colliding with an existing mount (the pool's
 * own mountpoint is `<base>/<pool>`). Create and edit refuse it, at the route
 * and in the job.
 */
function ahrBaseRefusal(mountpoint: string): Refusal | null {
  const mp = normalizeMountpointPath(mountpoint)
  const base = normalizeMountpointPath(ahrMountBase())
  if (mp !== base && !mp.startsWith(`${base}/`))
    return null
  return {
    status: 409,
    code: 'CONFLICT',
    reason: 'ahr-mount-base',
    message: `Mountpoint '${mp}' is under ${base}, where ANAS Hybrid RAID pools are mounted — a remote share there would collide with a pool's mountpoint. Choose a path outside ${base}.`,
  }
}

/** Is `mountpoint` a directory directly under `/` (`/mnt`, `/srv`, `/media`)? */
function isTopLevelDir(mountpoint: string): boolean {
  const n = normalizeMountpointPath(mountpoint)
  return n !== '/' && n.lastIndexOf('/') === 0
}

/** Does the findmnt table list `mountpoint` as mounted? */
function mountedIn(findmntText: string, mountpoint: string): boolean {
  return buildBaseInventory(findmntText, '', new Map()).find(r => r.mountpoint === mountpoint)?.mounted ?? false
}

/**
 * The busy confirm's lines: the forced (lazy) unmount and who loses access —
 * or, when the holders could not be listed (D3), that fact and what follows
 * from it: the unmount is not forced, so a busy mount fails the job before
 * anything else is changed.
 */
function busyWarnings(mountpoint: string, holders: Holder[], holdersUnknown: boolean): string[] {
  if (holdersUnknown)
    return [`The processes holding '${mountpoint}' could not be listed (neither lsof nor fuser answered). The unmount is not forced: if '${mountpoint}' is busy, the job fails and nothing else is changed.`]
  if (holders.length === 0)
    return []
  return [`Unmounting '${mountpoint}' will be forced (lazy unmount); these holders lose access:`, ...holders.map(holderLine)]
}

/** systemctl daemon-reload — re-runs the fstab generator after an fstab edit. */
async function daemonReload(executor: CommandExecutor): Promise<void> {
  const r = await executor.exec(SYSTEMCTL, ['daemon-reload'])
  if (r.exitCode !== 0)
    throw new Error(r.stderr.trim() || `systemctl daemon-reload exited ${r.exitCode}`)
}

/**
 * Mount a filesystem DIRECTLY from its entry (cr.52r D3): the spec and the
 * KERNEL/HELPER options the entry configures — the userspace-only fstab
 * tokens (`nofail`, `_netdev`, `x-*`) stay on the LINE and off the argv
 * (cr.52s-e) — through a directory the daemon itself opened
 * (`/proc/self/fd/3`, {@link mountThroughOpenedDir}) — the kernel resolves the
 * fd path to exactly that directory, so a parent swapped after the open cannot
 * redirect the mount to a place the gate never looked.
 *
 * `-c` is `--no-canonicalize` (cr.52r D3's comment fix): it is REQUIRED, not
 * optional — without it util-linux canonicalises `/proc/self/fd/3` to a real
 * path string and mounts onto THAT, which is precisely the redirect the pin
 * exists to stop. (cr.52's rationale claimed the opposite was true; it was a
 * confirmation error.) The `--` ends option parsing so the positional spec can
 * never be read as a `mount` flag (defence in depth; the schema already rejects
 * control chars). Throws on failure.
 */
async function doMount(executor: CommandExecutor, entry: MountEntry, mountpoint: string): Promise<void> {
  const args = ['-c', '-t', entry.fstype, ...directMountOptionArgs(entry), '--', entry.spec]
  const mp = normalizeMountpointPath(mountpoint)
  const r = await mountThroughOpenedDir(executor, mp, args)
  if (r.exitCode !== 0)
    throw new Error(r.stderr.trim() || `mount exited ${r.exitCode}`)
}

/**
 * Apply an edited fstab entry to the LIVE mount and PROVE the new options
 * landed (issue #25). umount + `mount <mp>` is the honest path; a mountpoint
 * that will not unmount (busy — virtiofsd, an open shell) falls back to
 * `mount -o remount`, which applies the remountable changes in place without
 * evicting the holders. A REFUSED unmount is never mounted over: util-linux
 * treats an already-mounted target as success, which is how a busy edit used to
 * complete green while the old options stayed live. On that path the KERNEL
 * MOUNT TABLE — not an exit code — decides whether the edit was delivered.
 */
async function remountEntry(executor: CommandExecutor, entry: MountEntry): Promise<void> {
  const mp = entry.mountpoint
  const u = await executor.exec(UMOUNT, [mp])
  if (u.exitCode !== 0 && (await readEffectiveOptions(executor, mp)) !== undefined) {
    // cr.52s-a (review P3): this ONE daemon-run mount(8) stays path-based, by
    // decision. A `remount` attaches no filesystem anywhere — it changes the
    // flags of the mount ALREADY at `mp`, and util-linux finds that mount and
    // merges the edited line's options by looking the TARGET up in fstab and
    // the mount table; a `/proc/self/fd/3` target appears in neither table, so
    // the remount would lose the edited options it exists to apply (a node
    // question this change does not measure — it keeps the known-good argv).
    // What guards it
    // instead: the update verb's gate ran the mount-target refusal on `mp`
    // (route and job), and the kernel mount table is read at `mp` before and
    // after — an edit is complete only when the options seen THERE match the
    // line. The residual is a swap of a parent in the instants between that
    // read and mount(8)'s own lookup, which can retarget only the flags of
    // another EXISTING mount, never place a filesystem.
    const r = await executor.exec(MOUNT, ['-o', 'remount', '--', mp])
    const effective = await readEffectiveOptions(executor, mp)
    if (effective !== undefined) {
      if (r.exitCode !== 0 || !deliveredMatchesIntent(effective, entry))
        throw new Error(await remountRefusedError(executor, mp, r, u))
      return
    }
    // Gone after all — fall through and mount it as written.
  }
  await doMount(executor, entry, mp)
}

/**
 * The honest failure when the live mount survived the edit: the previous options
 * are still in force, with the underlying error and the processes holding the
 * mountpoint named — the same fuser-backed diagnosis the busy paths use (`lsof`
 * is not installed on a stock PVE node).
 */
async function remountRefusedError(
  executor: CommandExecutor,
  mountpoint: string,
  remount: ExecResult,
  umount: ExecResult,
): Promise<string> {
  const detail = remount.exitCode !== 0
    ? cleanMountStderr(remount.stderr) || `mount -o remount exited ${remount.exitCode}`
    : umount.stderr.trim()
  const base = `Could not remount '${mountpoint}' — still mounted with previous options${detail ? ` (${detail})` : ''}`
  const holders = formatHolders(await diagnoseBusyPath(executor, mountpoint))
  return holders ? `${base}, ${holders}` : base
}

/**
 * What the holder listing of a busy mountpoint says. `listed` is an ANSWER —
 * possibly empty, meaning nothing holds it. `unknown` means no tool answered
 * (D3): neither lsof nor fuser could be started, or the listing ran out of its
 * budget. The confirm then says the holders could not be listed — never
 * "none" — and nothing is force-detached on an unknowable holder set.
 */
type HolderListing
  = | { state: 'listed', holders: Holder[] }
    | { state: 'unknown' }

/** One process holding a mountpoint, as lsof's COMMAND/PID or fuser's pid + `/proc/<pid>/comm` name it. */
interface Holder {
  pid: string
  command: string
}

/** How the confirm and the job's errors name a holder: `sleep (pid 713845)`. */
function holderLine(h: Holder): string {
  return `${h.command} (pid ${h.pid})`
}

/**
 * lsof's COMMAND column width: it prints at most this many characters of the
 * name (its default; ANAS passes no `+c`), while fuser's holders are named by
 * `/proc/<pid>/comm` (up to 15). The bound form cuts every name to this.
 */
const LSOF_COMMAND_WIDTH = 9
/** lsof's `\xNN` escape for a byte it will not print raw (a space in a name among them). */
const LSOF_HEX_ESCAPE_RE = /\\x([0-9a-f]{2})/gi

/**
 * A holder as the confirm BINDS it (nf.3 D10): the pid plus the name in the
 * form both listings can produce — lsof's `\xNN` escapes decoded, then cut to
 * lsof's nine characters — so the same process reads the same whichever tool
 * listed it at the challenge and which at the resend. The pid alone could be
 * a recycled number; the pid with a name is the process the operator saw.
 */
function holderKey(h: Holder): string {
  const name = h.command.replace(LSOF_HEX_ESCAPE_RE, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  return `${name.slice(0, LSOF_COMMAND_WIDTH)} (pid ${h.pid})`
}

/**
 * The holder set the busy confirm binds (nf.3 D10): `unknown` when no tool
 * answered (D3), `none` when nothing holds it (or it is not mounted), else
 * every holder's {@link holderKey} in pid order. A resend whose listing reads
 * otherwise — a holder more, one fewer, or a listing where the challenge had
 * none (or the reverse) — is 409 CONFIRM_SCOPE_CHANGED naming both sets.
 */
function boundHolders(listing: HolderListing | null): string {
  if (listing?.state === 'unknown')
    return 'unknown'
  if (!listing || listing.holders.length === 0)
    return 'none'
  // Two steps on an array we own (`toSorted()` is ES2023; this package targets ES2022).
  const keys = listing.holders.map(h => ({ pid: Number(h.pid), key: holderKey(h) }))
  keys.sort((a, b) => a.pid - b.pid)
  return keys.map(k => k.key).join(', ')
}

/**
 * List the processes holding a busy mountpoint (pid + name; {@link holderLine}
 * renders `COMMAND (pid N)`), for the cr.39 confirm and the forced unmount's
 * re-check (NOTES §5).
 *
 * `lsof +f -- <mp>` when lsof is on the node (the richest structured source).
 * A stock PVE 9 node has fuser (psmisc) and no lsof (D3), so when lsof cannot
 * be started the listing is {@link runFuser} — the `fuser -m <mp>` run and
 * parser the busy diagnosis uses, holders rendered the way lsof's rows are so
 * the confirm and the job's re-check agree. An lsof that TIMED OUT is not
 * retried with fuser: it walks the same hung mount, and two 10 s budgets in a
 * row overrun the gateway's 20 s — the listing is `unknown`.
 */
async function listHolders(executor: CommandExecutor, mountpoint: string, procRoot?: string): Promise<HolderListing> {
  let r: ExecResult | null
  try {
    r = await executor.exec(LSOF, ['+f', '--', mountpoint])
  }
  catch (err) {
    if (err instanceof CommandTimeoutError)
      return { state: 'unknown' }
    r = null // could not start (ENOENT/EACCES): no lsof on this node
  }
  if (r && !toolNotFound(r)) {
    const seen = new Map<string, Holder>()
    for (const line of r.stdout.split('\n').slice(1)) { // drop the header row
      const cols = line.trim().split(WHITESPACE_RE)
      if (cols.length < 2)
        continue
      const [command, pid] = cols
      if (!PID_RE.test(pid))
        continue
      seen.set(pid, { pid, command })
    }
    return { state: 'listed', holders: [...seen.values()] }
  }
  const holders = await runFuser(executor, mountpoint, procRoot ? { procRoot } : undefined)
  if (holders === null)
    return { state: 'unknown' }
  return { state: 'listed', holders: holders.map(h => ({ pid: String(h.pid), command: h.command })) }
}

/**
 * Directory listing for the empty-mountpoint check: the names, `missing`
 * when the path does not exist (the create will mkdir it), or `unreadable`
 * with the errno when the folder is there but the LISTING FAILED
 * (cr4.conf D-24). A failed read never reads as empty — a folder nobody
 * could list may hold data, and the confirm has to say exactly that.
 */
async function dirContents(path: string): Promise<
  { state: 'listed', names: string[] } | { state: 'missing' } | { state: 'unreadable', code: string }
> {
  try {
    return { state: 'listed', names: await readdir(path) }
  }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT')
      return { state: 'missing' }
    return { state: 'unreadable', code: code ?? 'unknown' }
  }
}

/**
 * Does the merged entry say exactly what the line already says (cr3.mounts
 * L12)? Compared in the canonical serialization both would be written in, with
 * the merge's forced `nofail` set back to the line's own value — so an edit
 * that only echoes the entry (the dialog sends every field on every save, #34)
 * is recognised as untouched whatever spelling the line was written in.
 */
function sameLine(existing: MountEntry, merged: MountEntry): boolean {
  const asLine = { ...merged, options: { ...merged.options, common: { ...merged.options.common, nofail: existing.options.common.nofail } } }
  return serializeMountLine(asLine) === serializeMountLine(existing)
}

/**
 * Merge an update's flat option changes onto an existing entry, under the clear
 * contract (issue #34): a value OVERRIDES, `null` REMOVES the stored option, and
 * an omitted field KEEPS it. Before the null case existed, a blanked dialog
 * field looked exactly like an untouched one, so an option could be set but
 * never unset. `nofail` stays forced true.
 */
function mergeEntry(
  existing: MountEntry,
  input: MountRequestOptions | undefined,
  automount: boolean | undefined,
  extraOptions: string | null | undefined,
): MountEntry {
  const common = { ...existing.options.common }
  if (input?.ro !== undefined)
    common.readOnly = input.ro
  if (input?.noatime !== undefined)
    common.noatime = input.noatime
  if (input?.nosuid !== undefined)
    common.nosuid = input.nosuid
  if (input?.nodev !== undefined)
    common.nodev = input.nodev
  if (input?.noexec !== undefined)
    common.noexec = input.noexec
  if (input?.netdev !== undefined)
    common.netdev = input.netdev
  applyOption(common, 'automountIdleTimeout', input?.idleTimeout)
  if (automount !== undefined)
    common.automount = automount
  // Turning Automount OFF takes its idle timeout with it: the renderer emits
  // x-systemd.idle-timeout independently of x-systemd.automount, so a stale
  // timeout would otherwise outlive the automount that gave it meaning. The
  // renderer stays dumb; the merge decides.
  if (automount === false)
    delete common.automountIdleTimeout
  common.nofail = true // always forced

  const options: MountOptions = {
    common,
    // An EMPTY (or null) extraOptions clears the passthrough — the operator
    // blanked the field. Only an omitted field keeps what was there. A
    // SUPPLIED value is re-validated at this write door (cr.2 — defence in
    // depth, Principle 6); PRESERVED hand-written passthrough is not.
    // cr3.mounts (review fix 6): a byte-equal echo of the stored passthrough
    // is the line's own and is kept as it is — a hand-written token that would
    // not pass the write-side token rule (an octal escape, a quote) must not
    // make every save of the line a 400. Anything else is validated.
    passthrough: extraOptions === undefined || extraOptions === existing.options.passthrough
      ? existing.options.passthrough
      : validatedExtraOptions(extraOptions, existing.options.passthrough),
  }
  if (isNfs(existing.fstype)) {
    const nfs = { ...existing.options.nfs }
    applyOption(nfs, 'vers', input?.vers)
    applyOption(nfs, 'hard', input?.hard)
    applyOption(nfs, 'timeo', input?.timeo)
    applyOption(nfs, 'retrans', input?.retrans)
    applyOption(nfs, 'rsize', input?.rsize)
    applyOption(nfs, 'wsize', input?.wsize)
    applyOption(nfs, 'proto', input?.proto)
    applyOption(nfs, 'noac', input?.noac)
    applyOption(nfs, 'actimeo', input?.actimeo)
    applyOption(nfs, 'nconnect', input?.nconnect)
    applyOption(nfs, 'bg', input?.bg)
    applyOption(nfs, 'lookupcache', input?.lookupcache)
    applySecOption(nfs, input?.sec, MountNfsSec.options)
    options.nfs = nfs
  }
  if (isCifs(existing.fstype)) {
    const cifs = { ...existing.options.cifs }
    applyOption(cifs, 'vers', input?.vers)
    applyOption(cifs, 'domain', input?.domain)
    applyOption(cifs, 'uid', input?.uid)
    applyOption(cifs, 'gid', input?.gid)
    applyOption(cifs, 'fileMode', input?.fileMode)
    applyOption(cifs, 'dirMode', input?.dirMode)
    applyOption(cifs, 'cache', input?.cache)
    applyOption(cifs, 'mfsymlinks', input?.mfsymlinks)
    applyOption(cifs, 'forceuid', input?.forceuid)
    applyOption(cifs, 'forcegid', input?.forcegid)
    applyOption(cifs, 'noserverino', input?.noserverino)
    applyOption(cifs, 'nobrl', input?.nobrl)
    applyOption(cifs, 'actimeo', input?.actimeo)
    applyOption(cifs, 'rsize', input?.rsize)
    applyOption(cifs, 'wsize', input?.wsize)
    applyOption(cifs, 'iocharset', input?.iocharset)
    applySecOption(cifs, input?.sec, MountCifsSec.options)
    options.cifs = cifs
  }

  return { ...existing, options }
}
