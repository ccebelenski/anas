import type { MountEntry, MountOptions, MountRequestOptions, MountSummary } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor, ExecResult } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { Advisory, Gate, GuardReads, GuardSpec, Refusal } from '../safety/guard.js'
import type { IscsiPaths } from '../services/iscsi.js'
import type { LiveAtTarget } from '../services/mount-match.js'
import type { MountTestStages } from '../services/mounts.js'
import { mkdir, readdir } from 'node:fs/promises'
import { AbsolutePath, CreateMountRequest, DeleteMountQuery, MountCifsSec, MountNfsSec, MountStateRequest, MountTestRequest, normalizeMountTarget, UpdateMountRequest } from '@anas/shared'
import { CommandTimeoutError } from '../executor/deadline.js'
import { classifyKind, parseFindmnt } from '../parsers/findmnt.js'
import { addMount, carriesAutomount, cifsAuthToken, disableMount, enableMount, getMount, hasMount, removeMount, replaceMount } from '../parsers/fstab.js'
import { readPveMountPaths, readZfsMountpoints } from '../parsers/pve-storage.js'
import { confirmGate } from '../safety/gate.js'
import { guardCheck, guardConfirm, guarded, GuardRefusalError, mountClaim, sendRefusal } from '../safety/guard.js'
import { diagnoseBusyPath, enrichBusyError, formatHolders, runFuser, toolNotFound } from '../services/busy-diagnosis.js'
import { editConfig, readConfig } from '../services/config-writer.js'
import { configfsOptionsFrom, createIscsiClaimCache, heldByLun, heldByLunRefusal } from '../services/iscsi-held.js'
import { describeLive, liveAtTarget, specMatchesLive } from '../services/mount-match.js'
import {
  ahrPinnedSpecs,
  applyOption,
  applySecOption,
  buildBaseInventory,
  buildMountDetail,
  cleanMountStderr,
  credsFilePath,
  deliveredMatchesIntent,
  entryFromRequest,
  fstabHasMount,
  fstabLineRevision,
  hasInlineCredentials,
  InvalidExtraOptionsError,
  isRemoteKind,
  mountpointReservedByPve,
  normalizeMountpointPath,
  probeInventoryHealth,
  pveStorageFor,
  readEffectiveOptions,
  readFindmnt,
  readMdadmConfText,
  removeCredentialsFileIfUnreferenced,
  removeEmptyMountpointDir,
  rotateCredentialsFile,
  runMountTest,
  stopAutomountUnit,
  systemMountTargetConflict,
  validatedExtraOptions,
  writeCredentialsFile,
} from '../services/mounts.js'
import { mountReferenceWarning, mountUnreadableWarning, poolReferenceKey, readMountReferences } from '../services/pool-references.js'
import { zodIssue } from '../validation.js'
import { requireIdentity } from './identity.js'

const SYSTEMCTL = '/usr/bin/systemctl'
const MOUNT = '/usr/bin/mount'
const UMOUNT = '/usr/bin/umount'
const LSOF = '/usr/bin/lsof'

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
    findmnt: (reads: GuardReads) => reads.once('findmnt', () => readFindmnt(executor)),
    fstab: (reads: GuardReads) => reads.once('fstab', () => readConfig(fstabPath)),
    pvePaths: (reads: GuardReads) => reads.once('pve-mount-paths', () => readPveMountPaths(storagePath)),
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
      mounted: mountedIn(findmntText, mountpoint),
      live: liveAtTarget(parseFindmnt(findmntText), mountpoint),
    }
  }

  // --- the gates (each one function, run by both doors) -------------------

  /** Reject a mutation on a PVE-owned mount (hands-off). */
  const pveGate: Gate<MountObject> = async (o, reads) => {
    if (!mountpointReservedByPve(o.mountpoint) && !pveStorageFor(o.mountpoint, await mountReads.pvePaths(reads)))
      return null
    return { status: 400, code: 'VALIDATION_ERROR', message: `Mount '${o.mountpoint}' is PVE-owned (hands-off) and cannot be modified by ANAS` }
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
    const row = buildBaseInventory(await mountReads.findmnt(reads), o.fstabText, new Map(), ahrSpecs).find(r => r.mountpoint === o.mountpoint)
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
      kind = buildBaseInventory(await mountReads.findmnt(reads), '', new Map()).find(r => r.mountpoint === o.mountpoint)?.type
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
    if (verb === 'update')
      gates.push(stateGate(o => !!o.entry, { status: 404, code: 'NOT_FOUND', message: `Mount '${mp}' is not in /etc/fstab` }))
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
      )
    }
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
    if (verb === 'unmount' || verb === 'disable' || verb === 'remove')
      gates.push(lunGate(verbing))
    return gates
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
    const kind = o.entry ? classifyKind(o.entry.fstype, o.entry.spec) : undefined
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
   */
  function createGuardSpec(mp: string): GuardSpec<MountSlot> {
    return {
      operation: 'mount.create',
      object: {
        what: `Mountpoint '${mp}'`,
        read: async reads => ({ mountpoint: mp, fstabText: await mountReads.fstab(reads) }),
        id: async () => ({ mountpoint: mp }),
        unbound: () => `Could not read the mountpoint '${mp}' — refusing`,
      },
      gates: [
        async s => mountpointReservedByPve(s.mountpoint)
          ? { status: 400, code: 'VALIDATION_ERROR', message: `Mountpoint '${s.mountpoint}' is PVE territory and off-limits to ANAS` }
          : null,
        async (s) => {
          const conflict = systemMountTargetConflict(s.mountpoint)
          return conflict ? { status: 400, code: 'VALIDATION_ERROR', message: `Invalid mountpoint: ${conflict}` } : null
        },
        async (s, reads) => pveStorageFor(s.mountpoint, await mountReads.pvePaths(reads))
          ? { status: 400, code: 'VALIDATION_ERROR', message: `Mountpoint '${s.mountpoint}' belongs to a PVE storage (hands-off)` }
          : null,
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
        async s => fstabHasMount(s.fstabText, s.mountpoint)
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
    const [findmntText, fstabText, pveMountPaths, ahrSpecs] = await Promise.all([
      readFindmnt(executor),
      readConfig(fstabPath),
      readPveMountPaths(storagePath),
      readAhrSpecs(),
    ])
    const rows = buildBaseInventory(findmntText, fstabText, pveMountPaths, ahrSpecs)
    await probeInventoryHealth(executor, rows)
    // Story iscsi.6: which mounts a LUN's image file sits under, so Unmount and
    // Remove can be greyed with the reason attached. ONE claims read for the
    // whole grid; additive, so a mount nothing holds carries no field.
    await annotateHeldByLun(rows)
    return { data: rows }
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

    // Story cr.39: the mountpoint-safety gates, run here and again in the job.
    const spec = createGuardSpec(req.mountpoint)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    // Empty-dir / shadow check: a non-empty existing directory needs confirmation.
    const contents = await dirContents(req.mountpoint)
    if (contents !== null && contents.length > 0) {
      if (!confirmGate(confirmStore, request, reply, {
        operation: 'mount.create',
        params: { mountpoint: req.mountpoint },
        message: `Mounting over '${req.mountpoint}' will shadow the ${contents.length} item(s) already there`,
        warnings: [
          `'${req.mountpoint}' is not empty — the mount will hide its current contents until unmounted.`,
        ],
      })) {
        return reply
      }
    }

    // The request schema already validated `extraOptions`; this re-check turns
    // any wayward value at the daemon's write door into a 400 (cr.2 — defence
    // in depth, Principle 6) rather than a fstab line.
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

    const job = jobQueue.submit(
      'mount.create',
      { ...identity, params: { mountpoint: req.mountpoint } },
      // Ruling (j): every gate above runs again before the first act — for a
      // NON-persistent create too (the "already in /etc/fstab" refusal used to
      // be re-checked only inside the persistent path's fstab edit).
      guarded(spec, pre, async (_slot, { updateProgress }) => {
        updateProgress(`Creating mountpoint ${req.mountpoint}`)
        await mkdir(req.mountpoint, { recursive: true })

        if (req.persistent) {
          updateProgress('Writing /etc/fstab entry')
          await editConfig(fstabPath, (current) => {
            if (hasMount(current, req.mountpoint))
              throw new Error(`Mount '${req.mountpoint}' is already in /etc/fstab`)
            return addMount(current, entry)
          })
          updateProgress('Reloading systemd (daemon-reload)')
          await daemonReload(executor)
        }

        // cr.18 (review M7.2): credentials land only once nothing that can
        // still refuse stands before them — for a persistent mount AFTER the
        // fstab edit that names the file, for a non-persistent mount
        // immediately before the `mount` that consumes it. A request refused
        // or a job step that fails earlier leaves no secrets on disk. A
        // non-persistent mount that is never mounted writes nothing: nothing
        // is left on the system that would ever reference the file.
        if (req.type === 'cifs' && req.credentials && (req.persistent || req.mountNow)) {
          updateProgress('Writing credentials file')
          await writeCredentialsFile(credsDir, req.mountpoint, req.credentials)
        }

        if (req.mountNow) {
          updateProgress(`Mounting ${req.mountpoint}`)
          await doMount(executor, req.persistent ? undefined : entry, req.mountpoint)
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

    // `mergeEntry` re-validates a SUPPLIED `extraOptions` at this write door
    // (cr.2 — defence in depth, Principle 6); a wayward value is a 400.
    let merged: MountEntry
    try {
      merged = mergeEntry(existing, body.options, body.automount, body.extraOptions)
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
    const migrating = hasInlineCredentials(existing)

    const job = jobQueue.submit(
      'mount.update',
      // The changed options ride the audit entry: a live diagnosis of "the edit
      // completed but nothing changed" (issue #25) had only the mountpoint to go on.
      { ...identity, params: { mountpoint: mp, ...(body.options ? { options: body.options } : {}) } },
      // Ruling (j): id, the line's revision and every gate (the foreign mount
      // check among them, right before anything is written) run again here.
      guarded(spec, pre, async (_o, { updateProgress }) => {
        // VALIDATE-THEN-COMMIT (issue #24): the new secret is proven against the
        // server BEFORE anything is written. Nothing below this point runs on a
        // rejected password, so the live creds file and fstab stay untouched.
        if (body.credentials) {
          updateProgress('Validating credentials')
          merged.credentialsFile = await rotateCredentialsFile(executor, credsDir, merged, body.credentials)
        }
        else if (migrating && existing.inlineCredentials?.password !== undefined) {
          // Operator did NOT retype the password: seed the creds file from the
          // EXTRACTED inline secret (one-time migration) so the mount keeps working
          // with its real password (specials like '#' preserved via the line-based
          // creds format). The plaintext never returns to the fstab line.
          updateProgress('Migrating inline credentials to a protected file')
          merged.credentialsFile = await writeCredentialsFile(credsDir, mp, {
            username: existing.inlineCredentials.username ?? '',
            password: existing.inlineCredentials.password,
            ...(existing.inlineCredentials.domain !== undefined ? { domain: existing.inlineCredentials.domain } : {}),
          })
        }
        if (migrating) {
          // Drop the inline tokens from the serialized entry (buildOptionTokens
          // already ignores inlineCredentials; also drop the now-migrated domain
          // option so it is not re-emitted inline).
          delete merged.inlineCredentials
          if (merged.options.cifs)
            delete merged.options.cifs.domain
        }
        updateProgress('Rewriting /etc/fstab entry')
        await editConfig(fstabPath, (current) => {
          if (!hasMount(current, mp))
            throw new Error(`Mount '${mp}' is not in /etc/fstab`)
          return replaceMount(current, mp, merged)
        })
        // A rotation writes the hashed name (ident.4 (d)); the file the line
        // named before (a pre-ident.4 flattened name) goes once nothing
        // references it — and only from the ANAS creds directory.
        const editWarnings: string[] = []
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
        guarded(spec, pre, async (_o, { updateProgress }) => {
          updateProgress(`Mounting ${mp}`)
          // Mounted from its fstab line (`mount -- <mp>`).
          await doMount(executor, undefined, mp)
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
          await editConfig(fstabPath, current => enableMount(current, mp))
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
          if (r.exitCode !== 0 && !lazy)
            throw new Error(await enrichBusyError(executor, r.stderr.trim() || `umount exited ${r.exitCode}`, mp, configfsOptionsFrom(iscsiPaths)))
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
          if (r.exitCode !== 0 && !lazy)
            throw new Error(await enrichBusyError(executor, r.stderr.trim() || `umount exited ${r.exitCode}`, mp, configfsOptionsFrom(iscsiPaths)))
        }
        if (o.entry) {
          updateProgress('Removing /etc/fstab entry')
          let automount = false
          await editConfig(fstabPath, (current) => {
            automount = carriesAutomount(current, mp) // the line BEFORE the change
            return removeMount(current, mp)
          })
          resultWarnings.push(...await stopAutomountIf(automount, mp, updateProgress))
          updateProgress('Reloading systemd (daemon-reload)')
          await daemonReload(executor)
        }
        // The file the confirm named (the scope check above proved it still is
        // the one); removed only from the creds dir and only when no other line
        // references it — decided on the fstab as it is after the line is gone.
        const file = credentialsFileOf(o)
        if (file) {
          updateProgress('Removing credentials file')
          const kept = await removeCredentialsFileIfUnreferenced(credsDir, file, await readConfig(fstabPath))
          if (kept)
            resultWarnings.push(kept)
        }
        if (removeMountpointDir) {
          // rmdir semantics only, and only once the mount is really gone. A
          // directory that will not go (not empty, still held) NEVER fails the
          // delete the user asked for — it rides the result as a warning.
          updateProgress(`Removing the mountpoint directory ${mp}`)
          const left = await removeEmptyMountpointDir(mp, await isMounted(mp))
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
    const result = await runMountTest(executor, parsed.data, mountTestStages)
    return { data: result }
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

  /** Is the mountpoint currently in the kernel mount table? */
  async function isMounted(mountpoint: string): Promise<boolean> {
    return mountedIn(await readFindmnt(executor), mountpoint)
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
 * Mount a filesystem. When `entry` is undefined the mount resolves from the
 * fstab line (`mount <mountpoint>`); otherwise it is mounted directly from the
 * entry's fields (the non-persistent path). Throws on failure.
 */
async function doMount(executor: CommandExecutor, entry: MountEntry | undefined, mountpoint: string): Promise<void> {
  // `--` ends option parsing so the positional spec/mountpoint can never be read
  // as a `mount` flag (defence in depth; the schema already rejects control chars).
  const args = entry
    ? ['-t', entry.fstype, '-o', serializeInlineOptions(entry), '--', entry.spec, mountpoint]
    : ['--', mountpoint]
  const r = await executor.exec(MOUNT, args)
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
    const r = await executor.exec(MOUNT, ['-o', 'remount', '--', mp])
    const effective = await readEffectiveOptions(executor, mp)
    if (effective !== undefined) {
      if (r.exitCode !== 0 || !deliveredMatchesIntent(effective, entry))
        throw new Error(await remountRefusedError(executor, mp, r, u))
      return
    }
    // Gone after all — fall through and mount it as written.
  }
  await doMount(executor, undefined, mp)
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

/** Build a `-o` option string for a direct (non-fstab) mount of an entry. */
function serializeInlineOptions(entry: MountEntry): string {
  const t: string[] = []
  const c = entry.options.common
  t.push(c.readOnly ? 'ro' : 'rw')
  if (entry.fstype === 'nfs4' || entry.fstype === 'nfs') {
    const n = entry.options.nfs
    if (n?.vers)
      t.push(`vers=${n.vers}`)
    if (n?.hard === false)
      t.push('soft')
    if (n?.proto)
      t.push(`proto=${n.proto}`)
    if (n?.sec)
      t.push(`sec=${n.sec}`)
    if (n?.timeo !== undefined)
      t.push(`timeo=${n.timeo}`)
    if (n?.retrans !== undefined)
      t.push(`retrans=${n.retrans}`)
    if (n?.rsize !== undefined)
      t.push(`rsize=${n.rsize}`)
    if (n?.wsize !== undefined)
      t.push(`wsize=${n.wsize}`)
    if (n?.actimeo !== undefined)
      t.push(`actimeo=${n.actimeo}`)
    if (n?.nconnect !== undefined)
      t.push(`nconnect=${n.nconnect}`)
    if (n?.lookupcache)
      t.push(`lookupcache=${n.lookupcache}`)
    if (n?.noac === true)
      t.push('noac')
    if (n?.bg === true)
      t.push('bg')
  }
  if (entry.fstype === 'cifs') {
    const cf = entry.options.cifs
    if (cf?.vers)
      t.push(`vers=${cf.vers}`)
    // The SAME auth token the fstab line and the preflight probe carry
    // (parsers/fstab.js): a credential-less CIFS mounts `guest`, never a
    // prompt.
    t.push(cifsAuthToken(entry.credentialsFile))
    if (cf?.domain)
      t.push(`domain=${cf.domain}`)
    if (cf?.uid !== undefined)
      t.push(`uid=${cf.uid}`)
    if (cf?.gid !== undefined)
      t.push(`gid=${cf.gid}`)
    if (cf?.fileMode)
      t.push(`file_mode=${cf.fileMode}`)
    if (cf?.dirMode)
      t.push(`dir_mode=${cf.dirMode}`)
    if (cf?.cache)
      t.push(`cache=${cf.cache}`)
    if (cf?.sec)
      t.push(`sec=${cf.sec}`)
    if (cf?.rsize !== undefined)
      t.push(`rsize=${cf.rsize}`)
    if (cf?.wsize !== undefined)
      t.push(`wsize=${cf.wsize}`)
    if (cf?.actimeo !== undefined)
      t.push(`actimeo=${cf.actimeo}`)
    if (cf?.iocharset)
      t.push(`iocharset=${cf.iocharset}`)
    if (cf?.mfsymlinks === true)
      t.push('mfsymlinks')
    if (cf?.forceuid === true)
      t.push('forceuid')
    if (cf?.forcegid === true)
      t.push('forcegid')
    if (cf?.noserverino === true)
      t.push('noserverino')
    if (cf?.nobrl === true)
      t.push('nobrl')
  }
  if (c.nosuid)
    t.push('nosuid')
  if (c.nodev)
    t.push('nodev')
  if (c.noexec)
    t.push('noexec')
  if (entry.options.passthrough)
    t.push(...entry.options.passthrough.split(','))
  return t.join(',')
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

/** Directory contents, or null when the path does not exist. */
async function dirContents(path: string): Promise<string[] | null> {
  try {
    return await readdir(path)
  }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT')
      return null
    return [] // exists but unreadable — treat as empty (don't block on EACCES)
  }
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
    passthrough: extraOptions === undefined ? existing.options.passthrough : validatedExtraOptions(extraOptions),
  }
  if (existing.fstype === 'nfs4' || existing.fstype === 'nfs') {
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
  if (existing.fstype === 'cifs') {
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
