import type { CommandExecutor } from '../executor/types.js'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import process from 'node:process'

/**
 * Raw block I/O and md sysfs knobs for the self-heal repair engine
 * (story selfheal.5) — the LOW level under `selfheal-map.ts`,
 * `selfheal-csum.ts` and `selfheal-repair.ts`, so none of them owns a private
 * copy of "read 4 KiB with O_DIRECT".
 *
 * ## Why `dd` and not an O_DIRECT fd
 *
 * O_DIRECT requires the USER BUFFER to be aligned to the device's logical
 * block size, and Node gives no way to allocate or even observe an aligned
 * Buffer: probed live on the node (kernel 7.0.14-12-pve, node 22), a
 * `Buffer.alloc(4096)` read succeeded by luck of the 8 KiB Buffer pool while
 * `Buffer.allocUnsafeSlow`, `new ArrayBuffer` and every size ≥ 64 KiB failed
 * with EINVAL. An engine whose correctness depends on where malloc happened to
 * land is not an engine. `dd` aligns its own buffer, is already this codebase's
 * O_DIRECT idiom (ahr-scrub's bad-block probe, story selfheal.3), and is
 * spawned through the executor with an argv array like everything else.
 *
 * Bytes come back through `base64` because {@link CommandExecutor} hands stdout
 * over as a STRING: binary would be mangled by the utf-8 decode. `base64` is
 * coreutils, on the executor's second pipeline stage, no shell involved.
 *
 * ## Guest philosophy
 *
 * Nothing here persists anything. The one temp file (the write path's payload)
 * lives under `/run` — tmpfs — and is removed in a `finally`. Every sysfs knob
 * this module touches is read before it is written so the caller can put it
 * back; see `selfheal-repair.ts`, which does exactly that.
 */

const DD = '/usr/bin/dd'
const BASE64 = '/usr/bin/base64'
const SYNC = '/usr/bin/sync'
const STAT = '/usr/bin/stat'

/** btrfs sector / md page unit. Everything in the engine is a multiple of this. */
export const BLOCK_BYTES = 4096

/**
 * The values md ships a RAID5/6 array with (GT-1, captured verbatim off a
 * fresh rig: `rmw_level=1`, `sync_min=0`, `sync_max=max`,
 * `stripe_cache_size=256`).
 *
 * They are here — in the md I/O layer, not in the engine that turns them — so
 * the repair's `finally` and the daemon-start reconciliation that has to clean
 * up after a repair that never GOT its `finally` restore the same numbers.
 */
export const MD_DEFAULT_RMW_LEVEL = '1'
/** @see MD_DEFAULT_RMW_LEVEL */
export const MD_DEFAULT_STRIPE_CACHE_SIZE = 256
/** @see MD_DEFAULT_RMW_LEVEL */
export const MD_DEFAULT_SYNC_MIN = '0'
/** @see MD_DEFAULT_RMW_LEVEL */
export const MD_DEFAULT_SYNC_MAX = 'max'

/** Where the write path stages its 4 KiB payload (tmpfs, removed in a finally). */
const DEFAULT_RUNTIME_DIR = '/run/anas'

/**
 * Prefix for the kernel's own pseudo-filesystems.
 *
 * Empty in production — `/sys` and `/proc` are where they always are. The
 * override exists so the engine's sequence can be unit-tested against a fake
 * md whose knobs are real files in a temp directory, the same shape as
 * `ahrMountBase`'s `ANAS_AHR_MOUNT_BASE`. It is never set on a node.
 */
export function kernelPath(path: string): string {
  return `${process.env.ANAS_SELFHEAL_KERNEL_ROOT ?? ''}${path}`
}

/** Where the write path stages its payload; overridable for the same reason. */
export function selfhealRuntimeDir(): string {
  return process.env.ANAS_SELFHEAL_RUNTIME_DIR ?? DEFAULT_RUNTIME_DIR
}

/** md sysfs directory of an array device (`/dev/md127` → `/sys/block/md127/md`). */
export function mdSysPath(mdKernelName: string): string {
  return kernelPath(`/sys/block/${mdKernelName}/md`)
}

/** Read one md sysfs attribute, trimmed. Throws if it does not exist. */
export async function readMdAttr(mdSys: string, key: string): Promise<string> {
  return (await readFile(`${mdSys}/${key}`, 'utf-8')).trim()
}

/** Read one md sysfs attribute, or null when the level does not have it. */
export async function readMdAttrOrNull(mdSys: string, key: string): Promise<string | null> {
  try {
    return await readMdAttr(mdSys, key)
  }
  catch {
    return null
  }
}

/** Write one md sysfs attribute. The kernel rejects some writes (EBUSY) — that throws. */
export async function writeMdAttr(mdSys: string, key: string, value: string): Promise<void> {
  await writeFile(`${mdSys}/${key}`, value)
}

/**
 * A direct read the device itself failed (dd's own exit), named by device so
 * a caller that knows the device is a member can say which disk to check
 * (review R1). The message is the one this read always threw.
 */
export class DirectReadError extends Error {
  constructor(message: string, readonly device: string, readonly byteOffset: number) {
    super(message)
    this.name = 'DirectReadError'
  }
}

/**
 * Read `length` bytes at `byteOffset` with O_DIRECT.
 *
 * Both must be multiples of {@link BLOCK_BYTES} — the caller's offsets come
 * from the mapping helper, which only ever produces aligned ones, so a
 * violation here is a bug and says so rather than silently short-reading.
 */
export async function readDirect(
  executor: CommandExecutor,
  device: string,
  byteOffset: number,
  length: number,
): Promise<Buffer> {
  if (byteOffset % BLOCK_BYTES !== 0 || length % BLOCK_BYTES !== 0 || length <= 0)
    throw new Error(`readDirect(${device}): offset ${byteOffset} / length ${length} not a multiple of ${BLOCK_BYTES}`)

  const r = await executor.pipeline(
    DD,
    [
      `if=${device}`,
      'iflag=direct',
      `bs=${BLOCK_BYTES}`,
      `skip=${byteOffset / BLOCK_BYTES}`,
      `count=${length / BLOCK_BYTES}`,
      'status=none',
    ],
    BASE64,
    ['-w', '0'],
  )
  if (r.leftExitCode !== 0)
    throw new DirectReadError(`read ${device} @${byteOffset}: dd exit ${r.leftExitCode}: ${r.leftStderr.trim()}`, device, byteOffset)
  if (r.rightExitCode !== 0)
    throw new Error(`read ${device} @${byteOffset}: base64 exit ${r.rightExitCode}: ${r.rightStderr.trim()}`)

  const buf = Buffer.from(r.stdout.trim(), 'base64')
  if (buf.length !== length)
    throw new Error(`read ${device} @${byteOffset}: got ${buf.length} bytes, wanted ${length}`)
  return buf
}

/**
 * Read a range with O_DIRECT and throw the bytes away.
 *
 * The stripe-cache eviction sweep reads tens of megabytes it never looks at;
 * routing that through base64 and a JS string would cost far more than the
 * read. Failures are ignored on purpose — a sweep read past the end of the
 * array is not an error, it is the end of the array.
 */
export async function readDiscard(
  executor: CommandExecutor,
  device: string,
  byteOffset: number,
  length: number,
): Promise<void> {
  await executor.exec(DD, [
    `if=${device}`,
    'iflag=direct',
    `bs=${BLOCK_BYTES}`,
    `skip=${byteOffset / BLOCK_BYTES}`,
    `count=${length / BLOCK_BYTES}`,
    'of=/dev/null',
    'status=none',
  ]).catch(() => {})
}

/**
 * Write `data` at `byteOffset` with O_DIRECT + fsync.
 *
 * This is the ONE write the engine makes, and it goes through the md device so
 * md rebuilds the whole parity group (the caller has already set `rmw_level=0`
 * — GT-7/GT-14: at the default, a cache-cold write-through updates parity
 * against the junk still on disk and poisons the stripe).
 */
export async function writeDirect(
  executor: CommandExecutor,
  device: string,
  byteOffset: number,
  data: Buffer,
): Promise<void> {
  if (byteOffset % BLOCK_BYTES !== 0 || data.length % BLOCK_BYTES !== 0 || data.length <= 0)
    throw new Error(`writeDirect(${device}): offset ${byteOffset} / length ${data.length} not a multiple of ${BLOCK_BYTES}`)

  const runtimeDir = selfhealRuntimeDir()
  await mkdir(runtimeDir, { recursive: true })
  // A directory of its OWN per call (cr3 AHR-HEAL-L11). The name used to be
  // `<pid>-<byteOffset>`, and two long-lane jobs on different pools — a repair
  // and a mirror reconcile, say — writing the same md byte offset at the same
  // moment would each have staged into the other's file: one pool's 4 KiB
  // written through the OTHER pool's md device. `mkdtemp` makes the name
  // unique by construction rather than by coincidence.
  const stageDir = await mkdtemp(join(runtimeDir, 'selfheal-write-'))
  const staged = join(stageDir, 'payload.bin')
  try {
    await writeFile(staged, data)
    const r = await executor.exec(DD, [
      `if=${staged}`,
      `of=${device}`,
      'oflag=direct',
      'conv=fsync,notrunc',
      `bs=${BLOCK_BYTES}`,
      `seek=${byteOffset / BLOCK_BYTES}`,
      `count=${data.length / BLOCK_BYTES}`,
      'status=none',
    ])
    if (r.exitCode !== 0)
      throw new Error(`write ${device} @${byteOffset}: dd exit ${r.exitCode}: ${r.stderr.trim()}`)
  }
  finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Read one 4 KiB block of a FILE with O_DIRECT and report only whether it read.
 *
 * This is the cold-read probe: a corrupt block whose csum fails comes back
 * EIO, and O_DIRECT is what makes the read real — a cached page would answer
 * from memory and every block would look fine (GT-9a).
 */
export async function probeFileBlock(
  executor: CommandExecutor,
  path: string,
  block: number,
): Promise<boolean> {
  const r = await executor.exec(DD, [
    `if=${path}`,
    'iflag=direct',
    `bs=${BLOCK_BYTES}`,
    `skip=${block}`,
    'count=1',
    'of=/dev/null',
    'status=none',
  ])
  return r.exitCode === 0
}

/**
 * What one cold read of a file block found (cr3 AHR-HEAL-M6).
 *
 *  - `ok`      the block read.
 *  - `bad`     the file is there and the read FAILED — on a btrfs file read
 *              with O_DIRECT that is the checksum refusing the block (GT-9a).
 *  - `missing` the path is not there at all, so nothing was read. A snapshot
 *              does not recurse into a nested subvolume (GT-52/55), and a file
 *              inside one is simply absent from it: that is a read that could
 *              not be taken, never a block that failed.
 */
export type FileBlockProbe = 'ok' | 'bad' | 'missing'

/**
 * {@link probeFileBlock}, with "the path is not there" told apart from "the
 * block did not read".
 *
 * The existence question is asked of `stat` — a structured exit code — rather
 * than read out of dd's error text.
 */
export async function probeFileBlockState(
  executor: CommandExecutor,
  path: string,
  block: number,
): Promise<FileBlockProbe> {
  const there = await executor.exec(STAT, ['-c', '%i', '--', path])
  if (there.exitCode !== 0)
    return 'missing'
  return (await probeFileBlock(executor, path, block)) ? 'ok' : 'bad'
}

/** `sync` + `drop_caches=3`. The cold read is worthless without it. */
export async function dropCaches(executor: CommandExecutor): Promise<void> {
  await executor.exec(SYNC, [])
  await writeFile(kernelPath('/proc/sys/vm/drop_caches'), '3\n')
}

/** Kernel name of a device path (`/dev/md/pool-r1` → `md127`), via realpath. */
export async function kernelName(executor: CommandExecutor, device: string): Promise<string> {
  const r = await executor.exec('/usr/bin/readlink', ['-f', device])
  if (r.exitCode !== 0 || !r.stdout.trim())
    throw new Error(`cannot resolve ${device}: ${r.stderr.trim()}`)
  return basename(r.stdout.trim())
}

/** `await sleep(ms)` — the md knobs need settling time, not a spin. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
