/**
 * cr3.lunrestore — a small model of what LIO holds, replayed from the argv a
 * test executor saw. Test-only (no `.test.ts` suffix: the runner does not
 * collect it).
 *
 * It applies only the calls that SUCCEEDED (the recording executor below keeps
 * each call's exit code), in the order they ran, so at any prefix of a run it
 * answers "what does the kernel target hold right now" and "what did the last
 * `saveconfig` persist". That is what the crash table needs: a daemon that
 * stops after call K leaves exactly the live tree of the first K calls, and a
 * node that reboots comes back with the last saved tree.
 *
 * The argv shapes are the ones `services/iscsi-mutate.ts` emits (GT-5: one
 * targetcli command per invocation), and nothing else is modelled.
 */
import type { IscsiTargetDetail } from '@anas/shared'
import type { CommandExecutor, ExecOptions, ExecResult, ExecStreamOptions, ExecStreamResult, ExecStreamTarget, PipelineResult } from '../../executor/types.js'
import type { ConfigfsBackstore, ConfigfsTpg, LioLiveState } from '../iscsi-configfs.js'
import type { TargetObject } from '../iscsi-guard.js'
import type { HoleIoFacts } from '../iscsi-hole.js'
import type { DeviceStat } from '../iscsi-served.js'
import type { IscsiReadContext } from '../iscsi.js'
import type { RestoreJobRecord, RestoreMarkRead } from '../restore-mark.js'
import { restoreHoles } from '../iscsi-health.js'
import { holeKey } from '../iscsi-hole.js'
import { TARGETCLI, ZFS } from '../iscsi-mutate.js'
import { markOn } from '../restore-mark.js'

/** One recorded call and how it ended. `exitCode: null` = it never returned (the run halted inside it). */
export interface RecordedCall {
  command: string
  args: string[]
  kind: 'exec' | 'stream'
  exitCode: number | null
}

export interface ModelBackstore { name: string, plugin: string, dev: string, wwn: string }
export interface ModelLun { iqn: string, tag: number, index: number, backstore: string, plugin: string }
export interface LioTree { backstores: ModelBackstore[], luns: ModelLun[] }
export interface LioModel extends LioTree {
  /** What the last successful `saveconfig` persisted; null = nothing saved in this run. */
  saved: LioTree | null
  /** ZFS volumes this run created and has not destroyed. */
  volumes: string[]
  /** Volumes carrying the restore mark (`zfs set anas:restore=<value>`, cleared by `zfs inherit`). */
  marks: string[]
}

const LUNS_PATH_RE = /^\/iscsi\/(.+)\/tpg(\d+)\/luns$/
const STORAGE_OBJECT_RE = /^storage_object=\/backstores\/([^/]+)\/(.+)$/

function kv(args: string[], key: string): string | undefined {
  return args.find(a => a.startsWith(`${key}=`))?.slice(key.length + 1)
}

function copyTree(t: LioTree): LioTree {
  return { backstores: t.backstores.map(b => ({ ...b })), luns: t.luns.map(l => ({ ...l })) }
}

/** Replay the successful calls of `calls` (all of them, or the first `upTo`) onto an empty tree. */
export function replayLio(calls: RecordedCall[], upTo = calls.length, landed: (c: RecordedCall) => boolean = () => false): LioModel {
  const m: LioModel = { backstores: [], luns: [], saved: null, volumes: [], marks: [] }
  for (const c of calls.slice(0, upTo)) {
    // `landed`: a call that reported a failure (a timeout) but took effect.
    if (c.exitCode !== 0 && !landed(c))
      continue
    if (c.command === ZFS) {
      const ds = c.args.at(-1) ?? ''
      if (c.args[0] === 'create') {
        m.volumes.push(ds)
      }
      else if (c.args[0] === 'destroy') {
        m.volumes = m.volumes.filter(v => v !== ds)
        m.marks = m.marks.filter(v => v !== ds)
      }
      else if (c.args[0] === 'set' && (c.args[1] ?? '').startsWith('anas:restore=')) {
        if (!m.marks.includes(ds))
          m.marks.push(ds)
      }
      else if (c.args[0] === 'inherit' && c.args[1] === 'anas:restore') {
        m.marks = m.marks.filter(v => v !== ds)
      }
      continue
    }
    if (c.command !== TARGETCLI)
      continue
    const [path, verb, ...rest] = c.args
    if (path === 'saveconfig') {
      m.saved = copyTree(m)
      continue
    }
    if (path.startsWith('/backstores/') && verb === 'create') {
      const plugin = path.slice('/backstores/'.length)
      m.backstores.push({ name: kv(rest, 'name') ?? '', plugin, dev: kv(rest, 'dev') ?? kv(rest, 'file_or_dev') ?? '', wwn: kv(rest, 'wwn') ?? '' })
      continue
    }
    if (path.startsWith('/backstores/') && verb === 'delete') {
      const plugin = path.slice('/backstores/'.length)
      m.backstores = m.backstores.filter(b => !(b.plugin === plugin && b.name === rest[0]))
      continue
    }
    const luns = LUNS_PATH_RE.exec(path)
    if (luns && verb === 'create') {
      const so = STORAGE_OBJECT_RE.exec(rest[0] ?? '')
      m.luns.push({ iqn: luns[1], tag: Number(luns[2]), index: Number(kv(rest, 'lun')), backstore: so?.[2] ?? '', plugin: so?.[1] ?? '' })
      continue
    }
    if (luns && verb === 'delete') {
      const index = Number((rest[0] ?? '').replace('lun', ''))
      m.luns = m.luns.filter(l => !(l.iqn === luns[1] && l.tag === Number(luns[2]) && l.index === index))
    }
  }
  return m
}

/** A live configfs backstore for a model one. */
export function configfsBackstore(b: ModelBackstore): ConfigfsBackstore {
  return {
    name: b.name,
    plugin: b.plugin === 'block' ? 'iblock' : b.plugin,
    hbaIndex: 0,
    udevPath: b.dev,
    serial: b.wwn,
    productId: b.name,
    vendorId: 'LIO-ORG',
    enabled: true,
    status: 'DEACTIVATED',
    claimed: null,
    kernelDevice: null,
    size: null,
    devMajor: null,
    devMinor: null,
    attributes: {},
  }
}

/**
 * The read context of a node whose kernel target holds `tree` live and whose
 * saveconfig.json holds `saved`, beside a FIXED source target: `base`, whose
 * LUNs (and their backstores) are added to both sides. Classification inputs
 * are a node with no PVE storage, so a `/dev/zvol/<pool>/<vol>` backing is an
 * ANAS zvol.
 */
export function contextOf(tree: LioTree, saved: LioTree | null, base: { iqn: string, tag: number, backstores: ModelBackstore[], luns: ModelLun[] }): IscsiReadContext {
  const liveBackstores = [...base.backstores, ...tree.backstores]
  const liveLuns = [...base.luns, ...tree.luns]
  const tpg = (luns: ModelLun[]): ConfigfsTpg => ({
    tag: base.tag,
    enabled: true,
    authentication: false,
    generateNodeAcls: false,
    demoModeDiscovery: false,
    portals: [],
    luns: luns.filter(l => l.iqn === base.iqn && l.tag === base.tag)
      .map(l => ({ index: l.index, backstoreName: l.backstore, plugin: l.plugin === 'block' ? 'iblock' : l.plugin })),
    acls: [],
    dynamicSessionsRaw: '',
  })
  const live: LioLiveState = {
    present: true,
    backstores: liveBackstores.map(configfsBackstore),
    targets: [{ iqn: base.iqn, tpgs: [tpg(liveLuns)] }],
  }
  const savedTree = saved ? { backstores: [...base.backstores, ...saved.backstores], luns: [...base.luns, ...saved.luns] } : { backstores: base.backstores, luns: base.luns }
  const persisted = {
    storageObjects: savedTree.backstores.map(b => ({ name: b.name, plugin: b.plugin, dev: b.dev, wwn: b.wwn, size: null, writeBack: false, readOnly: null, aio: false, attributes: {} })),
    targets: [{
      iqn: base.iqn,
      fabric: 'iscsi',
      tpgs: [{
        tag: base.tag,
        enable: true,
        authentication: false,
        generateNodeAcls: false,
        demoModeDiscovery: false,
        tpgCredentialsSet: false,
        portals: [],
        luns: savedTree.luns.map(l => ({ index: l.index, storageObject: `/backstores/${l.plugin}/${l.backstore}`, backstoreName: l.backstore, plugin: l.plugin })),
        acls: [],
      }],
    }],
  } as unknown as IscsiReadContext['persisted']
  const paths = [...new Set([...liveBackstores, ...savedTree.backstores].map(b => b.dev))]
  return {
    live,
    persisted,
    inputs: { pveStorages: new Map(), zfsMountpoints: [], systemFacts: [] },
    nodeAddresses: null,
    backing: new Map(paths.map(p => [p, { exists: true, size: null }])),
    mounts: new Map(),
    stubs: new Map(),
  }
}

/** The `refreshAfterCreate` answer a test hands the service: the target as given, the live tree of the model. */
export function targetObjectOf(target: IscsiTargetDetail, ctx: IscsiReadContext): TargetObject {
  return { target, state: { ctx, targets: [target] } }
}

/** A block device no model backstore names, so a default stat is never "served elsewhere". */
const UNCLAIMED: DeviceStat = { type: 'block', rdevMajor: 230, rdevMinor: 0, dev: '0', ino: '0', size: 0 }

/** What a test overrides about a hole's I/O facts. */
export interface HoleIoOver {
  /** The mark read; default absent for every hole whose backing is present. */
  mark?: RestoreMarkRead
  /** A restore running onto the backing. */
  running?: string
  /** The retained failed restore onto the backing. */
  record?: RestoreJobRecord
  /** The backing's stat (block or fileio); default a device nothing serves. */
  device?: DeviceStat | null
}

/**
 * The I/O facts `computeIscsiHealth`'s `holeIo` takes, for every hole whose
 * backing is present — the shape `read()` gathers, so a test can drive the
 * verdict through `computeIscsiHealth` without a configfs tree on disk.
 */
export function holeIoFor(ctx: IscsiReadContext, targets: IscsiTargetDetail[], over: HoleIoOver = {}): Map<string, HoleIoFacts> {
  const out = new Map<string, HoleIoFacts>()
  for (const { hole } of restoreHoles(ctx, targets)) {
    if (hole.backingExists !== true)
      continue
    out.set(holeKey(hole), {
      device: over.device === undefined ? UNCLAIMED : over.device,
      mark: over.mark ?? { state: 'absent', dataset: markOn(hole.backingPath) ?? hole.backingPath },
      running: over.running,
      record: over.record,
    })
  }
  return out
}

/**
 * Wrap a base executor: record every call with its exit code, and optionally
 * HALT the run at call number `haltAt` (0-based, counting exec and stream
 * calls together) — that call does not return, which is what a daemon or node
 * stopping inside it looks like from the run's side. `halted` settles when the
 * run reaches it; `resume()` then makes the halted call throw, so a test can
 * snapshot the node first and still let the run (and the iSCSI mutex it may
 * hold) unwind before the next test.
 */
export function recording(base: CommandExecutor, opts: { haltAt?: number } = {}): {
  executor: CommandExecutor
  calls: RecordedCall[]
  halted: Promise<void>
  resume: () => void
} {
  const calls: RecordedCall[] = []
  let arrive!: () => void
  const halted = new Promise<void>((resolve) => {
    arrive = resolve
  })
  let resume!: () => void
  const resumed = new Promise<never>((_resolve, reject) => {
    resume = () => reject(new Error('the run was halted here (a crash) and is unwound by the test'))
  })
  resumed.catch(() => {})
  const maybeHalt = async (): Promise<void> => {
    if (opts.haltAt !== undefined && calls.length - 1 === opts.haltAt) {
      arrive()
      await resumed
    }
  }
  const executor: CommandExecutor = {
    async exec(command: string, args: string[], o?: ExecOptions): Promise<ExecResult> {
      const rec: RecordedCall = { command, args, kind: 'exec', exitCode: null }
      calls.push(rec)
      await maybeHalt()
      const r = await base.exec(command, args, o)
      rec.exitCode = r.exitCode
      return r
    },
    pipeline(c1: string, a1: string[], c2: string, a2: string[]): Promise<PipelineResult> {
      return base.pipeline(c1, a1, c2, a2)
    },
    async execToStream(command: string, args: string[], target: ExecStreamTarget, o?: ExecStreamOptions): Promise<ExecStreamResult> {
      const rec: RecordedCall = { command, args, kind: 'stream', exitCode: null }
      calls.push(rec)
      await maybeHalt()
      const r = await base.execToStream(command, args, target, o)
      rec.exitCode = r.exitCode
      return r
    },
  }
  return { executor, calls, halted, resume }
}
