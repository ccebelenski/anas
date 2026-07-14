import type { SmbConnection, SmbShareDetail } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import { CreateSmbShareRequest, ShareName, UpdateSmbGlobalConfigRequest, UpdateSmbShareRequest } from '@anas/shared'
import { addShare, getShare, hasShare, parseSmbConf, removeShare, updateGlobal, updateShare } from '../parsers/smb-conf.js'
import { parseSmbStatusJson, parseSmbStatusText } from '../parsers/smbstatus.js'
import { confirmGate } from '../safety/gate.js'
import { ConfigConflictError, editConfig, readConfig } from '../services/config-writer.js'
import { requireIdentity } from './identity.js'

const SMBSTATUS = '/usr/bin/smbstatus'
const SYSTEMCTL = '/usr/bin/systemctl'

export interface SmbShareRouteOptions {
  executor: CommandExecutor
  jobQueue: JobQueue
  confirmStore: ConfirmStore
  /** Absolute path to smb.conf (config IS the API — Principle 13). */
  smbConfPath: string
}

export async function smbShareRoutes(
  server: FastifyInstance,
  opts: SmbShareRouteOptions,
) {
  const { executor, jobQueue, confirmStore, smbConfPath } = opts

  /** Read smb.conf fresh every time — the file is the source of truth (P.11). */
  async function readSmbConf(): Promise<string> {
    return readConfig(smbConfPath)
  }

  /** Live connections keyed by share (service), from smbstatus (JSON first). */
  async function connectionsByShare(): Promise<Record<string, SmbConnection[]>> {
    const json = await executor.exec(SMBSTATUS, ['--json'])
    if (json.exitCode === 0 && json.stdout.trim().startsWith('{')) {
      try {
        return parseSmbStatusJson(json.stdout)
      }
      catch {
        // Fall through to the text parser below.
      }
    }
    const text = await executor.exec(SMBSTATUS, ['-S'])
    if (text.exitCode === 0 && text.stdout.trim())
      return parseSmbStatusText(text.stdout)
    return {}
  }

  /** Live connections for a given share, from smbstatus (JSON preferred). */
  async function connectionsFor(shareName: string): Promise<SmbConnection[]> {
    return (await connectionsByShare())[shareName] ?? []
  }

  /** Every live connection across all shares (for global-change impact). */
  async function allConnections(): Promise<SmbConnection[]> {
    const byShare = await connectionsByShare()
    return Object.values(byShare).flat()
  }

  /** Reload smbd so the config change takes effect (side effect of the job). */
  async function reloadSmbd(): Promise<void> {
    const r = await executor.exec(SYSTEMCTL, ['reload', 'smbd'])
    if (r.exitCode !== 0)
      throw new Error(r.stderr.trim() || `systemctl reload smbd exited with code ${r.exitCode}`)
  }

  /** Order-insensitive equality for the interface list (a reorder is a no-op). */
  function sameStringList(a: string[], b: string[]): boolean {
    if (a.length !== b.length)
      return false
    const setB = new Set(b)
    return a.every(v => setB.has(v))
  }

  /** Map a ConfigConflictError raised in a job into a clear job error. */
  function asJobError(err: unknown): Error {
    if (err instanceof ConfigConflictError)
      return new Error(`smb.conf changed on disk during the operation — retry against the current state`)
    return err instanceof Error ? err : new Error(String(err))
  }

  // --- GET /shares/smb — ALL shares (incl. admin-created, Principle 11) -----
  server.get('/shares/smb', async () => {
    const text = await readSmbConf()
    return { data: parseSmbConf(text).shares }
  })

  // --- GET /shares/smb/global — SMB global config ---------------------------
  // Registered before the `:name` route; Fastify prioritises static paths anyway.
  server.get('/shares/smb/global', async () => {
    const text = await readSmbConf()
    return { data: parseSmbConf(text).global }
  })

  // --- PUT /shares/smb/global — update [global] -----------------------------
  server.put('/shares/smb/global', async (request, reply) => {
    const bodyParsed = UpdateSmbGlobalConfigRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid global config update: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Guard only the disruptive change: retargeting which interfaces/addresses
    // smbd binds to can cut off clients when smbd rebinds on reload. Cosmetic
    // edits (workgroup, server string) reload without dropping sessions, so they
    // stay unguarded. Gate only when the binding actually changes AND there are
    // live connections that could be dropped.
    const current = parseSmbConf(await readSmbConf()).global
    const interfacesChanged = req.interfaces !== undefined
      && !sameStringList(req.interfaces, current.interfaces)
    const bindChanged = req.bindInterfacesOnly !== undefined
      && req.bindInterfacesOnly !== current.bindInterfacesOnly

    if (interfacesChanged || bindChanged) {
      const conns = await allConnections()
      if (conns.length > 0) {
        const warnings = [
          `${conns.length} active SMB connection(s) may be dropped when smbd rebinds to the new interface list.`,
        ]
        const machines = [...new Set(conns.map(c => c.machine).filter(Boolean))]
        if (machines.length > 0)
          warnings.push(`Connected clients: ${machines.join(', ')}.`)

        // Signature is the resource identity only (section: 'global') — never
        // the changed values, so the confirm code stays valid on resend.
        if (!confirmGate(confirmStore, request, reply, {
          operation: 'smb.config.set',
          params: { section: 'global' },
          message: `Changing the SMB interface binding reloads smbd and may disconnect active clients`,
          warnings,
        })) {
          return reply
        }
      }
    }

    const job = jobQueue.submit(
      'smb.config.set',
      { ...identity, params: { section: 'global', config: req } },
      async () => {
        try {
          await editConfig(smbConfPath, current => updateGlobal(current, req))
        }
        catch (err) {
          throw asJobError(err)
        }
        await reloadSmbd()
        return { updated: 'global' }
      },
    )

    reply.code(202)
    return { job }
  })

  // --- GET /shares/smb/:name — share detail + active connections ------------
  server.get<{ Params: { name: string } }>('/shares/smb/:name', async (request, reply) => {
    const nameParsed = ShareName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid share name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const text = await readSmbConf()
    const share = getShare(text, name)
    if (!share) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `SMB share '${name}' not found` } }
    }

    const detail: SmbShareDetail = { ...share, connections: await connectionsFor(share.name) }
    return { data: detail }
  })

  // --- POST /shares/smb — create a share ------------------------------------
  server.post('/shares/smb', async (request, reply) => {
    const bodyParsed = CreateSmbShareRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid create share request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // 409 if the share already exists — the config file is the source of truth.
    const text = await readSmbConf()
    if (hasShare(text, req.name)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `SMB share '${req.name}' already exists` } }
    }

    const job = jobQueue.submit(
      'smb.share.add',
      { ...identity, params: { share: req.name, path: req.path } },
      async () => {
        try {
          await editConfig(smbConfPath, current => addShare(current, req))
        }
        catch (err) {
          throw asJobError(err)
        }
        await reloadSmbd()
        return { created: req.name }
      },
    )

    reply.code(202)
    return { job }
  })

  // --- PUT /shares/smb/:name — update a share -------------------------------
  server.put<{ Params: { name: string } }>('/shares/smb/:name', async (request, reply) => {
    const nameParsed = ShareName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid share name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const bodyParsed = UpdateSmbShareRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid update share request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const text = await readSmbConf()
    if (!hasShare(text, name)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `SMB share '${name}' not found` } }
    }

    const job = jobQueue.submit(
      'smb.config.set',
      { ...identity, params: { share: name, config: req } },
      async () => {
        try {
          await editConfig(smbConfPath, current => updateShare(current, name, req))
        }
        catch (err) {
          throw asJobError(err)
        }
        await reloadSmbd()
        return { updated: name }
      },
    )

    reply.code(202)
    return { job }
  })

  // --- DELETE /shares/smb/:name — remove a share (confirmation-gated) -------
  server.delete<{ Params: { name: string } }>('/shares/smb/:name', async (request, reply) => {
    const nameParsed = ShareName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid share name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const text = await readSmbConf()
    const share = getShare(text, name)
    if (!share) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `SMB share '${name}' not found` } }
    }

    const connections = await connectionsFor(share.name)

    const warnings = [
      `Removing SMB share '${name}' makes the shared path '${share.path}' inaccessible over SMB.`,
    ]
    if (connections.length > 0)
      warnings.push(`${connections.length} active connection(s) to '${name}' will be terminated on reload.`)

    if (!confirmGate(confirmStore, request, reply, {
      operation: 'smb.share.remove',
      params: { share: name },
      message: `Removing SMB share '${name}' stops sharing '${share.path}'`,
      warnings,
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'smb.share.remove',
      { ...identity, params: { share: name } },
      async () => {
        try {
          await editConfig(smbConfPath, current => removeShare(current, name))
        }
        catch (err) {
          throw asJobError(err)
        }
        await reloadSmbd()
        return { removed: name }
      },
    )

    reply.code(202)
    return { job }
  })
}
