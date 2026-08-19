import type { MountEntry, MountOptions, MountRequestOptions } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor, ExecResult } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import { mkdir, readdir } from 'node:fs/promises'
import { AbsolutePath, CreateMountRequest, DeleteMountQuery, MountCifsSec, MountNfsSec, MountStateRequest, MountTestRequest, UpdateMountRequest } from '@anas/shared'
import { classifyKind } from '../parsers/findmnt.js'
import { addMount, disableMount, enableMount, getMount, hasMount, removeMount, replaceMount } from '../parsers/fstab.js'
import { readPveMountPaths, readZfsMountpoints } from '../parsers/pve-storage.js'
import { confirmGate } from '../safety/gate.js'
import { diagnoseBusyPath, enrichBusyError, formatHolders } from '../services/busy-diagnosis.js'
import { editConfig, readConfig } from '../services/config-writer.js'
import {
  ahrPinnedSpecs,
  buildBaseInventory,
  buildMountDetail,
  cleanMountStderr,
  credsFilePath,
  deliveredMatchesIntent,
  entryFromRequest,
  fstabHasMount,
  hasInlineCredentials,
  isRemoteKind,
  mountpointReservedByPve,
  probeInventoryHealth,
  pveStorageFor,
  readEffectiveOptions,
  readFindmnt,
  readMdadmConfText,
  removeCredentialsFile,
  removeEmptyMountpointDir,
  rotateCredentialsFile,
  runMountTest,
  writeCredentialsFile,
} from '../services/mounts.js'
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
}

/**
 * Mounts (Epic 18) — external & local storage. Pure management: ANAS surgically
 * edits /etc/fstab (round-trip parser) and invokes mount/umount; the kernel and
 * systemd's fstab generator do the work. PVE-owned mounts (read-only
 * storage.cfg parse) are tagged hands-off and reject every mutation. All
 * mutations are jobs (202); status never touches a mountpoint synchronously
 * (guarded `stat -f` in a child process).
 */
export async function mountsRoutes(server: FastifyInstance, opts: MountsRouteOptions) {
  const { executor, jobQueue, confirmStore, fstabPath, credsDir, storagePath, mdadmConfPath } = opts

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
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid create mount request: ${parsed.error.issues[0]?.message}` } }
    }
    const req = parsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Remote shares only (see rejectIfNotRemote): a mount needs its server.
    if (!req.server) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `A ${req.type} mount requires 'server' (and 'remotePath')` } }
    }
    if (req.type === 'cifs' && !req.credentials) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: 'CIFS mounts require credentials (username/password)' } }
    }

    // Mountpoint safety: never PVE territory; never an existing ZFS dataset.
    if (mountpointReservedByPve(req.mountpoint)) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Mountpoint '${req.mountpoint}' is PVE territory and off-limits to ANAS` } }
    }
    if (pveStorageFor(req.mountpoint, await readPveMountPaths(storagePath))) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Mountpoint '${req.mountpoint}' belongs to a PVE storage (hands-off)` } }
    }
    if ((await readZfsMountpoints()).some(m => m.mountpoint === req.mountpoint)) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Mountpoint '${req.mountpoint}' is a ZFS dataset mountpoint` } }
    }

    // Already configured?
    if (req.persistent && fstabHasMount(await readConfig(fstabPath), req.mountpoint)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Mount '${req.mountpoint}' is already in /etc/fstab` } }
    }

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

    const { entry, warnings } = entryFromRequest(req, credsDir)

    const job = jobQueue.submit(
      'mount.create',
      { ...identity, params: { mountpoint: req.mountpoint } },
      async (updateProgress) => {
        if (req.type === 'cifs' && req.credentials) {
          updateProgress('Writing credentials file')
          await writeCredentialsFile(credsDir, req.mountpoint, req.credentials)
        }
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

        if (req.mountNow) {
          updateProgress(`Mounting ${req.mountpoint}`)
          await doMount(executor, req.persistent ? undefined : entry, req.mountpoint)
        }
        return { created: req.mountpoint, warnings }
      },
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
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid update mount request: ${parsed.error.issues[0]?.message}` } }
    }
    const body = parsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const rejected = await rejectIfPve(mp, reply)
    if (rejected)
      return rejected

    const rejectedAhr = await rejectIfAhr(mp, reply)
    if (rejectedAhr)
      return rejectedAhr

    const existing = getMount(await readConfig(fstabPath), mp)
    if (!existing) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Mount '${mp}' is not in /etc/fstab` } }
    }

    const rejectedLocal = await rejectIfNotRemote(mp, existing, reply)
    if (rejectedLocal)
      return rejectedLocal

    const merged = mergeEntry(existing, body.options, body.automount, body.extraOptions)
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
      async (updateProgress) => {
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
        updateProgress('Reloading systemd (daemon-reload)')
        await daemonReload(executor)
        updateProgress(`Remounting ${mp}`)
        await remountEntry(executor, merged)
        return { updated: mp }
      },
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
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid mount state request: ${parsed.error.issues[0]?.message}` } }
    }
    const { action } = parsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const rejected = await rejectIfPve(mp, reply)
    if (rejected)
      return rejected

    const rejectedAhr = await rejectIfAhr(mp, reply)
    if (rejectedAhr)
      return rejectedAhr

    const fstabText = await readConfig(fstabPath)
    const entry = getMount(fstabText, mp)
    const mounted = await isMounted(mp)

    const rejectedLocal = await rejectIfNotRemote(mp, entry, reply)
    if (rejectedLocal)
      return rejectedLocal

    // --- mount: bring it up (keep the fstab entry) ---
    if (action === 'mount') {
      if (!entry && !mounted) {
        reply.code(404)
        return { error: { code: 'NOT_FOUND', message: `Mount '${mp}' is not configured and not mounted` } }
      }
      if (entry?.disabled) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Mount '${mp}' is disabled — enable it first` } }
      }
      const job = jobQueue.submit(
        'mount.mount',
        { ...identity, params: { mountpoint: mp } },
        async (updateProgress) => {
          updateProgress(`Mounting ${mp}`)
          await doMount(executor, entry && !fstabHasMount(fstabText, mp) ? entry : undefined, mp)
          return { mounted: mp }
        },
      )
      reply.code(202)
      return { job }
    }

    // --- enable: strip the marker only (config inverse of disable; no mount) ---
    if (action === 'enable') {
      if (!entry) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Mount '${mp}' is not in /etc/fstab` } }
      }
      if (!entry.disabled) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Mount '${mp}' is not disabled` } }
      }
      const job = jobQueue.submit(
        'mount.enable',
        { ...identity, params: { mountpoint: mp } },
        async (updateProgress) => {
          updateProgress(`Enabling ${mp} in /etc/fstab`)
          await editConfig(fstabPath, current => enableMount(current, mp))
          updateProgress('Reloading systemd (daemon-reload)')
          await daemonReload(executor)
          return { enabled: mp }
        },
      )
      reply.code(202)
      return { job }
    }

    // --- disable / unmount both unmount first (busy → the same 409 gate) ---
    const disabling = action === 'disable'
    if (disabling && !entry) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Mount '${mp}' is not in /etc/fstab — nothing to disable` } }
    }
    if (!disabling && !mounted) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Mount '${mp}' is not currently mounted` } }
    }

    let lazy = false
    if (mounted) {
      const gate = await busyGate(mp, `mount.${action}`, request, reply)
      if (gate === 'sent')
        return reply
      lazy = gate.lazy
    }

    const job = jobQueue.submit(
      `mount.${action}`,
      { ...identity, params: { mountpoint: mp } },
      async (updateProgress) => {
        if (mounted) {
          updateProgress(`Unmounting ${mp}${lazy ? ' (lazy)' : ''}`)
          const r = await executor.exec(UMOUNT, lazy ? ['-l', mp] : [mp])
          if (r.exitCode !== 0 && !lazy)
            throw new Error(await enrichBusyError(executor, r.stderr.trim() || `umount exited ${r.exitCode}`, mp))
        }
        if (disabling) {
          // Comment the fstab line with the marker; KEEP the credentials file.
          updateProgress(`Disabling ${mp} in /etc/fstab`)
          await editConfig(fstabPath, current => disableMount(current, mp))
          updateProgress('Reloading systemd (daemon-reload)')
          await daemonReload(executor)
          return { disabled: mp }
        }
        return { unmounted: mp }
      },
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
    // directory. Absent ⇒ false ⇒ the pre-flag behaviour, byte for byte.
    const query = DeleteMountQuery.safeParse(request.query ?? {})
    if (!query.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid delete mount query: ${query.error.issues[0]?.message}` } }
    }
    const { removeMountpointDir } = query.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const rejected = await rejectIfPve(mp, reply)
    if (rejected)
      return rejected

    const rejectedAhr = await rejectIfAhr(mp, reply)
    if (rejectedAhr)
      return rejectedAhr

    const fstabText = await readConfig(fstabPath)
    const entry = getMount(fstabText, mp)
    const mounted = await isMounted(mp)
    if (!entry && !mounted) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Mount '${mp}' not found` } }
    }

    const rejectedLocal = await rejectIfNotRemote(mp, entry ?? undefined, reply)
    if (rejectedLocal)
      return rejectedLocal

    let lazy = false
    if (mounted) {
      const gate = await busyGate(mp, 'mount.remove', request, reply)
      if (gate === 'sent')
        return reply
      lazy = gate.lazy
    }

    const kind = entry ? classifyKind(entry.fstype, entry.spec) : undefined
    const credentialsFile = entry?.credentialsFile ?? (kind === 'cifs' ? credsFilePath(credsDir, mp) : undefined)

    const job = jobQueue.submit(
      'mount.remove',
      { ...identity, params: { mountpoint: mp, ...(removeMountpointDir ? { removeMountpointDir } : {}) } },
      async (updateProgress) => {
        const warnings: string[] = []
        if (mounted) {
          updateProgress(`Unmounting ${mp}${lazy ? ' (lazy)' : ''}`)
          const r = await executor.exec(UMOUNT, lazy ? ['-l', mp] : [mp])
          if (r.exitCode !== 0 && !lazy)
            throw new Error(await enrichBusyError(executor, r.stderr.trim() || `umount exited ${r.exitCode}`, mp))
        }
        if (entry) {
          updateProgress('Removing /etc/fstab entry')
          await editConfig(fstabPath, current => removeMount(current, mp))
          updateProgress('Reloading systemd (daemon-reload)')
          await daemonReload(executor)
        }
        if (credentialsFile) {
          updateProgress('Removing credentials file')
          await removeCredentialsFile(credentialsFile)
        }
        if (removeMountpointDir) {
          // rmdir semantics only, and only once the mount is really gone. A
          // directory that will not go (not empty, still held) NEVER fails the
          // delete the user asked for — it rides the result as a warning.
          updateProgress(`Removing the mountpoint directory ${mp}`)
          const left = await removeEmptyMountpointDir(mp, await isMounted(mp))
          if (left)
            warnings.push(left)
        }
        return { removed: mp, ...(warnings.length > 0 ? { warnings } : {}) }
      },
    )

    reply.code(202)
    return { job }
  })

  // --- POST /mounts/test — synchronous preflight diagnosis ----------------
  server.post('/mounts/test', async (request, reply) => {
    const parsed = MountTestRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid mount test request: ${parsed.error.issues[0]?.message}` } }
    }
    const identity = requireIdentity(request, reply)
    if (!identity)
      return
    const result = await runMountTest(executor, parsed.data)
    return { data: result }
  })

  // --- helpers ------------------------------------------------------------

  /** Is the mountpoint currently in the kernel mount table? */
  async function isMounted(mountpoint: string): Promise<boolean> {
    const findmntText = await readFindmnt(executor)
    return buildBaseInventory(findmntText, '', new Map()).find(r => r.mountpoint === mountpoint)?.mounted ?? false
  }

  /**
   * Busy-unmount gate: if holders are present, 409-confirm carrying the list
   * (force/lazy behind the gate). Returns 'sent' when the 409 was sent (caller
   * must `return reply`), else `{ lazy }` telling the job whether to lazy-unmount.
   */
  async function busyGate(
    mountpoint: string,
    operation: string,
    request: import('fastify').FastifyRequest,
    reply: FastifyReply,
  ): Promise<'sent' | { lazy: boolean }> {
    const holders = await listHolders(executor, mountpoint)
    if (holders.length === 0)
      return { lazy: false }
    if (!confirmGate(confirmStore, request, reply, {
      operation,
      params: { mountpoint },
      message: `'${mountpoint}' is busy — ${holders.length} process(es) are holding it`,
      warnings: [
        `Unmounting '${mountpoint}' will be forced (lazy unmount); these holders lose access:`,
        ...holders,
      ],
    })) {
      return 'sent'
    }
    return { lazy: true } // confirmed
  }

  /**
   * NAS-surface guard (operator ruling): ANAS mutates REMOTE share mounts
   * only. Local filesystems are observe-only — the local-drive path is ZFS or
   * AHR, not generic mount management. Returns a 400 body when
   * the target exists and is not an NFS/CIFS mount; unknown targets fall
   * through to the handlers' own 404s.
   */
  async function rejectIfNotRemote(
    mountpoint: string,
    entry: { fstype: string, spec: string } | undefined,
    reply: FastifyReply,
  ): Promise<object | undefined> {
    let kind: string | undefined = entry ? classifyKind(entry.fstype, entry.spec) : undefined
    if (kind === undefined) {
      const findmntText = await readFindmnt(executor)
      kind = buildBaseInventory(findmntText, '', new Map()).find(r => r.mountpoint === mountpoint)?.type
    }
    if (kind !== undefined && !isRemoteKind(kind)) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Mount '${mountpoint}' is a local filesystem — ANAS manages remote shares only (local storage is ZFS territory)` } }
    }
    return undefined
  }

  /** Reject a mutation on a PVE-owned mount (hands-off). Returns a body to send. */
  async function rejectIfPve(mountpoint: string, reply: FastifyReply): Promise<object | undefined> {
    if (mountpointReservedByPve(mountpoint) || pveStorageFor(mountpoint, await readPveMountPaths(storagePath))) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Mount '${mountpoint}' is PVE-owned (hands-off) and cannot be modified by ANAS` } }
    }
    return undefined
  }

  /**
   * Reject a mutation on an AHR pool's persistence (hands-off — mirrors
   * rejectIfPve). A Mounts unmount/delete/edit on a pool's LV entry would rip
   * the pool's persistence out from under the Hybrid RAID feature. Matches on
   * the LV SPEC via the shared inventory tagging (never the mountpoint), so a
   * custom-mountpoint pool is still refused.
   */
  async function rejectIfAhr(mountpoint: string, reply: FastifyReply): Promise<object | undefined> {
    if (!mdadmConfPath)
      return undefined
    const [findmntText, fstabText, ahrSpecs] = await Promise.all([
      readFindmnt(executor),
      readConfig(fstabPath),
      readAhrSpecs(),
    ])
    if (ahrSpecs.size === 0)
      return undefined
    const row = buildBaseInventory(findmntText, fstabText, new Map(), ahrSpecs).find(r => r.mountpoint === mountpoint)
    if (row?.ahrManaged) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Mount '${mountpoint}' is an ANAS Hybrid RAID (AHR) pool — manage it from the Hybrid RAID view, not the Mounts feature` } }
    }
    return undefined
  }

  /** Parse + validate a URL-encoded mountpoint param, or 400 and return null. */
  function parseMountpoint(raw: string, reply: FastifyReply): string | null {
    const parsed = AbsolutePath.safeParse(raw)
    if (!parsed.success) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Invalid mountpoint: ${parsed.error.issues[0]?.message}` } })
      return null
    }
    return parsed.data
  }
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
    if (entry.credentialsFile)
      t.push(`credentials=${entry.credentialsFile}`)
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
 * List the processes holding a busy mountpoint via `lsof +f -- <mp>` (the
 * richest structured source; NOTES §5), as `COMMAND (pid N)` strings. Fail-open
 * to an empty list (nothing holding, or lsof unavailable).
 */
async function listHolders(executor: CommandExecutor, mountpoint: string): Promise<string[]> {
  try {
    const r = await executor.exec(LSOF, ['+f', '--', mountpoint])
    const lines = r.stdout.split('\n').slice(1) // drop the header row
    const seen = new Map<string, string>()
    for (const line of lines) {
      const cols = line.trim().split(WHITESPACE_RE)
      if (cols.length < 2)
        continue
      const [command, pid] = cols
      if (!PID_RE.test(pid))
        continue
      seen.set(pid, `${command} (pid ${pid})`)
    }
    return [...seen.values()]
  }
  catch {
    return []
  }
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
 * Merge an update's flat option changes onto an existing entry. Provided fields
 * override; omitted fields are kept. `nofail` stays forced true.
 */
function mergeEntry(
  existing: MountEntry,
  input: MountRequestOptions | undefined,
  automount: boolean | undefined,
  extraOptions: string | undefined,
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
  if (input?.idleTimeout !== undefined)
    common.automountIdleTimeout = input.idleTimeout
  if (automount !== undefined)
    common.automount = automount
  common.nofail = true // always forced

  const options: MountOptions = {
    common,
    passthrough: extraOptions ?? existing.options.passthrough,
  }
  if (existing.fstype === 'nfs4' || existing.fstype === 'nfs') {
    const nfs = { ...existing.options.nfs }
    if (input?.vers !== undefined)
      nfs.vers = input.vers
    if (input?.hard !== undefined)
      nfs.hard = input.hard
    if (input?.timeo !== undefined)
      nfs.timeo = input.timeo
    if (input?.retrans !== undefined)
      nfs.retrans = input.retrans
    if (input?.rsize !== undefined)
      nfs.rsize = input.rsize
    if (input?.wsize !== undefined)
      nfs.wsize = input.wsize
    if (input?.proto !== undefined)
      nfs.proto = input.proto
    if (input?.noac !== undefined)
      nfs.noac = input.noac
    if (input?.actimeo !== undefined)
      nfs.actimeo = input.actimeo
    if (input?.nconnect !== undefined)
      nfs.nconnect = input.nconnect
    if (input?.bg !== undefined)
      nfs.bg = input.bg
    if (input?.lookupcache !== undefined)
      nfs.lookupcache = input.lookupcache
    if (input?.sec !== undefined) {
      const s = MountNfsSec.safeParse(input.sec)
      if (s.success)
        nfs.sec = s.data
    }
    options.nfs = nfs
  }
  if (existing.fstype === 'cifs') {
    const cifs = { ...existing.options.cifs }
    if (input?.vers !== undefined)
      cifs.vers = input.vers
    if (input?.domain !== undefined)
      cifs.domain = input.domain
    if (input?.uid !== undefined)
      cifs.uid = input.uid
    if (input?.gid !== undefined)
      cifs.gid = input.gid
    if (input?.fileMode !== undefined)
      cifs.fileMode = input.fileMode
    if (input?.dirMode !== undefined)
      cifs.dirMode = input.dirMode
    if (input?.cache !== undefined)
      cifs.cache = input.cache
    if (input?.mfsymlinks !== undefined)
      cifs.mfsymlinks = input.mfsymlinks
    if (input?.forceuid !== undefined)
      cifs.forceuid = input.forceuid
    if (input?.forcegid !== undefined)
      cifs.forcegid = input.forcegid
    if (input?.noserverino !== undefined)
      cifs.noserverino = input.noserverino
    if (input?.nobrl !== undefined)
      cifs.nobrl = input.nobrl
    if (input?.actimeo !== undefined)
      cifs.actimeo = input.actimeo
    if (input?.rsize !== undefined)
      cifs.rsize = input.rsize
    if (input?.wsize !== undefined)
      cifs.wsize = input.wsize
    if (input?.iocharset !== undefined)
      cifs.iocharset = input.iocharset
    if (input?.sec !== undefined) {
      const s = MountCifsSec.safeParse(input.sec)
      if (s.success)
        cifs.sec = s.data
    }
    options.cifs = cifs
  }

  return { ...existing, options }
}
