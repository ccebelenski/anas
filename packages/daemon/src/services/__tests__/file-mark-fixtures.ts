/**
 * cr3.lunrestore.filemark — the CAPTURED getfattr/setfattr calls
 * (`fixtures/restore-mark/file-mark.*.txt`, README there) as test inputs, and
 * a stateful fake of an image file's extended attribute whose every answer is
 * a captured answer with the path (and the value) swapped in. Test-only (no
 * `.test.ts` suffix: the runner does not collect it).
 *
 * A fake shaped by the builder's assumption hides live failures: this one
 * prints nothing that was not seen on a node, and `file-mark.test.ts` holds
 * it to the captures.
 */
import type { CommandExecutor, ExecResult } from '../../executor/types.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FILE_RESTORE_MARK_ATTR, GETFATTR, SETFATTR } from '../restore-mark.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'restore-mark')

/** One captured call: where, what ran, and what it printed. */
export interface CapturedCase {
  node: string
  fs: string
  name: string
  /** The argv after the command (the `$` line, split on spaces: no captured word has one). */
  args: string[]
  command: string
  /** The path the call named (its last word). */
  path: string
  stdout: string
  stderr: string
  exitCode: number
}

const HEADER_RE = /^### (\S+) (\S+) (\S+)$/
const COUNT_RE = /^--- (stdout|stderr) (\d+)$/
const EXIT_RE = /^EXIT=(\d+)$/

/** Parse one capture file (the format `fixtures/restore-mark/file-mark-capture.sh` writes: byte counts, then the bytes). */
function parseCaptures(text: string): CapturedCase[] {
  const out: CapturedCase[] = []
  let i = 0
  const line = (): string => {
    const end = text.indexOf('\n', i)
    const l = text.slice(i, end)
    i = end + 1
    return l
  }
  const block = (kind: 'stdout' | 'stderr'): string => {
    const m = COUNT_RE.exec(line())
    if (!m || m[1] !== kind)
      throw new Error(`capture: expected '--- ${kind} <n>' at byte ${i}`)
    const n = Number(m[2])
    const body = text.slice(i, i + n)
    i += n + 1 // the bytes, then the newline the writer adds
    return body
  }
  while (i < text.length) {
    const h = HEADER_RE.exec(line())
    if (!h)
      throw new Error(`capture: expected a '### node fs case' header at byte ${i}`)
    const words = line().split(' ')
    if (words[0] !== '$')
      throw new Error(`capture: expected the '$' argv line of ${h[3]}`)
    const stdout = block('stdout')
    const stderr = block('stderr')
    const e = EXIT_RE.exec(line())
    if (!e)
      throw new Error(`capture: expected EXIT= after ${h[3]}`)
    const command = words[1] === 'getfattr' ? GETFATTR : words[1] === 'setfattr' ? SETFATTR : words[1]
    out.push({ node: h[1], fs: h[2], name: h[3], command, args: words.slice(2), path: words.at(-1)!, stdout, stderr, exitCode: Number(e[1]) })
  }
  return out
}

let cache: CapturedCase[] | null = null

/** Every captured case, from both nodes. */
export function capturedCases(): CapturedCase[] {
  cache ??= ['file-mark.anas-zfs.txt', 'file-mark.anas-pve.txt'].flatMap(f => parseCaptures(readFileSync(join(FIXTURES, f), 'utf-8')))
  return cache
}

/** One captured case by node, filesystem label and case name. */
export function capturedCase(node: string, fs: string, name: string): CapturedCase {
  const c = capturedCases().find(x => x.node === node && x.fs === fs && x.name === name)
  if (!c)
    throw new Error(`no captured case '${node} ${fs} ${name}'`)
  return c
}

/** The hex a captured `getfattr -e hex` printed (the value after `=0x`). */
export function capturedHex(c: CapturedCase): string {
  const m = /^trusted\.anas\.restore=0x([0-9a-f]*)$/m.exec(c.stdout)
  if (!m)
    throw new Error(`case ${c.name} printed no value`)
  return m[1]
}

/** The captured answer, for the same call on `path` (and, for a value read, with `hex` as the value). */
export function answerAs(c: CapturedCase, path: string, hex?: string): ExecResult {
  const swap = (s: string): string => {
    let t = s.split(c.path).join(path)
    if (hex !== undefined)
      t = t.replace(/^(trusted\.anas\.restore=0x)[0-9a-f]*$/m, `$1${hex}`)
    return t
  }
  return { stdout: swap(c.stdout), stderr: swap(c.stderr), exitCode: c.exitCode }
}

/** What the prod executor rejects with when the binary is not on the node (spawn ENOENT; `file-mark.test.ts` checks the shape against a real spawn). */
export function enoent(command: string): Error {
  return Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT', errno: -2, syscall: `spawn ${command}`, path: command })
}

/**
 * Wrap an executor so image files keep `trusted.anas.restore` the way the
 * captured nodes keep it (ext4 on anas-pve by default): `setfattr -n -v 0x..`
 * stores the hex, `setfattr -x` removes it ("No such attribute" when there is
 * none), `getfattr` answers from it. Every answer is a captured one.
 *  - `unsupported` paths answer as the vfat capture (Operation not supported);
 *  - `readOnly` paths refuse a set or remove as the read-only ext4 capture;
 *  - `unreadable` paths make getfattr reject (the executor lost the child);
 *  - `notInstalled`: both binaries reject with spawn ENOENT.
 */
export function withFileMarks(
  base: CommandExecutor,
  initial: Record<string, string> = {},
  opts: { unsupported?: Set<string>, readOnly?: Set<string>, unreadable?: Set<string>, notInstalled?: boolean, failSetHex?: (hex: string) => boolean } = {},
) {
  const marks = new Map(Object.entries(initial))
  const C = (name: string, fs = 'ext4') => capturedCase('anas-pve', fs, name)
  const executor: CommandExecutor = {
    async exec(command, args, o) {
      if (command !== GETFATTR && command !== SETFATTR)
        return base.exec(command, args, o)
      if (opts.notInstalled)
        throw enoent(command)
      const path = args.at(-1)!
      if (command === GETFATTR) {
        if (opts.unreadable?.has(path))
          throw new Error(`Command timed out after 12000ms: ${GETFATTR} ${args.join(' ')}`)
        if (opts.unsupported?.has(path))
          return answerAs(C('unsupported-read', 'vfat'), path)
        const hex = marks.get(path)
        return hex === undefined ? answerAs(C('read-absent'), path) : answerAs(C('read-writing'), path, hex)
      }
      if (opts.unsupported?.has(path))
        return answerAs(C(args[0] === '-x' ? 'unsupported-remove' : 'unsupported-set', 'vfat'), path)
      if (opts.readOnly?.has(path))
        return answerAs(C(args[0] === '-x' ? 'readonly-remove' : 'readonly-set'), path)
      if (args[0] === '-x' && args[1] === FILE_RESTORE_MARK_ATTR) {
        if (!marks.has(path))
          return answerAs(C('remove-absent'), path)
        marks.delete(path)
        return answerAs(C('remove'), path)
      }
      if (args[0] === '-n' && args[1] === FILE_RESTORE_MARK_ATTR && args[2] === '-v') {
        const hex = args[3].replace(/^0x/, '')
        if (opts.failSetHex?.(hex))
          return answerAs(C('readonly-set'), path)
        marks.set(path, hex)
        return answerAs(C('set-writing'), path)
      }
      throw new Error(`withFileMarks: an argv no capture covers: ${command} ${args.join(' ')}`)
    },
    pipeline: (c1, a1, c2, a2, o) => base.pipeline(c1, a1, c2, a2, o),
    execToStream: (c, a, t, o) => base.execToStream(c, a, t, o),
  }
  /** The mark on a path, decoded (the JSON's `state`, or the raw text). */
  const stateOf = (path: string): string => {
    const hex = marks.get(path)
    if (hex === undefined)
      return 'none'
    const raw = Buffer.from(hex, 'hex').toString('utf8')
    try {
      return (JSON.parse(raw) as { state?: string }).state ?? raw
    }
    catch {
      return raw
    }
  }
  return { executor, marks, stateOf }
}

/** A value as the writer's hex. */
export function hexOf(text: string): string {
  return Buffer.from(text, 'utf8').toString('hex')
}
