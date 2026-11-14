import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import type { MockExecutor } from '../../executor/mock.js'
import type { createServer } from '../../server.js'
import { lstat, open, readlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { accessDirIo } from '../../services/access.js'

const TRAILING_SLASHES_RE = /\/+$/

/** The walk helper's interpreter (services/access.ts runs `/usr/bin/perl <anas-acl-walk>`). */
const PERL = '/usr/bin/perl'

/** The path each stand-in descriptor was opened for (the pin's readlink answer). */
const standIns = new Map<number, string>()

/** Every path the writer asked to pin, in order (cr3.shares review 2, item 9). */
const pinned: string[] = []

/** The paths pinned since the last {@link resetPinned}, in order. */
export function pinnedPaths(): string[] {
  return [...pinned]
}

/** Forget the recorded pins (each server start does). */
export function resetPinned(): void {
  pinned.length = 0
}

/** A root-owned plain directory, for a test path that does not exist on this host. */
const STAND_IN_DIR = { uid: 0, gid: 0, mode: 0o40755, dev: 0, ino: 0, isSymbolicLink: () => false, isDirectory: () => true } as unknown as Stats

/** One run of the walk helper as the writer asked for it (cr3.shares, fourth review). */
export interface WalkRun {
  /** The job the writer sent on stdin. */
  job: {
    roots: { fd: number, path: string, dev: number, ino: number, zfs: boolean }[]
    tools: { chown: string, chmod: string, setfacl: string }
    chown?: string
    acl?: string
    defaultAcl?: string
    setgid?: boolean
    clear?: boolean
    mode?: string
  }
  /** How many descriptors the helper inherited (one per root, fd 3, 4, ...). */
  inheritedFds: number
}

const walks: WalkRun[] = []

/** Every walk the writer ran since the server started, in order. */
export function walkRuns(): WalkRun[] {
  return [...walks]
}

/** A completed walk's report line, as the helper prints it. */
export function walkReport(extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ done: true, visited: { files: 3, dirs: 2 }, changed: {}, failed: {}, skipped: { links: 0, other: 0 }, swapped: 0, vanished: 0, boundary: 0, boundaries: [], nestedRoots: 0, zfsControl: 0, tooDeep: 0, errors: 0, maxDepth: 863, notes: [], accounted: true, ...extra })}\n`
}

/**
 * The walk helper stand-in: the dev mock has no `perl`, and the tests stand
 * on directories that do not exist — the helper itself is proven for real in
 * services/__tests__/access-acl-walk.test.ts and access-boundary-ns.test.ts.
 * Here the job the writer SENT is what a test asserts ({@link walkRuns}).
 */
function answerWalk(stdin: string, fds: number[]): { stdout: string, stderr: string, exitCode: number } {
  const run: WalkRun = { job: JSON.parse(stdin) as WalkRun['job'], inheritedFds: fds.length }
  walks.push(run)
  return { stdout: walkReport(), stderr: '', exitCode: 0 }
}

/**
 * cr3.shares H2: the permissions writer resolves a share path by its own
 * safe-path walk (`accessDirIo.lstat`/`readlink`) and writes through ONE
 * descriptor per directory it opened (`accessDirIo.open`, proven by
 * readlink). The access tests stand on directories that do not exist on the
 * test host — so the walk sees each of them as a root-owned plain directory,
 * and the pin opens a stand-in directory whose kernel name reads back as the
 * directory asked for, RECORDING each path it was asked to pin so a test can
 * assert exactly which directories the writer pinned ({@link pinnedPaths}).
 * The `realpath` echo is kept for any caller that still asks it.
 */
export function echoRealPaths<S extends ReturnType<typeof createServer>>(server: S): S {
  const mock = (server as unknown as { executor: MockExecutor }).executor
  const orig = mock.exec.bind(mock)
  mock.exec = async (command, args, opts) => {
    if (command === '/usr/bin/realpath' && args.length === 3 && args[0] === '-e' && args[1] === '--')
      return { stdout: `${args[2].replace(TRAILING_SLASHES_RE, '') || '/'}\n`, stderr: '', exitCode: 0 }
    if (command === PERL && args.length === 1 && args[0].endsWith('anas-acl-walk.pl')) {
      // The real executor announces every child it spawns (fifth review D1):
      // so does the stand-in — a child that has already exited.
      opts?.onSpawn?.({ pid: 1, kill: () => false, killGroup: () => false, exited: () => true, exit: Promise.resolve() })
      return answerWalk(opts?.stdin ?? '', opts?.inheritedFds ?? [])
    }
    return orig(command, args, opts)
  }
  standInPins()
  resetPinned()
  walks.length = 0
  return server
}

/** Install the stand-in pin (idempotent): see {@link echoRealPaths}. */
export function standInPins(): void {
  accessDirIo.open = async (path: string) => {
    pinned.push(path)
    const handle = await open(tmpdir(), 'r')
    standIns.set(handle.fd, path)
    const close = handle.close.bind(handle)
    return Object.assign(handle, {
      close: async () => {
        standIns.delete(handle.fd)
        await close()
      },
    }) as FileHandle
  }
  accessDirIo.readlink = async (path: string) => standIns.get(Number(path.split('/').pop())) ?? readlink(path)
  // The helper is stood in (answerWalk): its script is "there".
  accessDirIo.readable = async () => {}
  // The safe-path walk: a path that exists answers as itself; one that does
  // not (the dev mock's /testpool/media) stands in as a root-owned plain
  // directory — no test path here is a link.
  accessDirIo.lstat = async (path: string) => lstat(path).catch(() => STAND_IN_DIR)
  // The pin's identity check (N1): a stand-in descriptor is the directory it
  // stands in for — it answers that directory's lstat, as the plan saw it.
  accessDirIo.fstat = async (handle: FileHandle) => {
    const path = standIns.get(handle.fd)
    return path === undefined ? handle.stat() : accessDirIo.lstat(path)
  }
}
