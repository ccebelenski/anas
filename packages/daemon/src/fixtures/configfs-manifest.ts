/**
 * Materialise a captured configfs tree from a manifest file.
 *
 * configfs cannot be checked into git — it is a kernel filesystem of hundreds of
 * one-value files plus symlinks whose targets escape the tree. So the iSCSI
 * ground-truth capture is stored as a flat, reviewable MANIFEST
 * (`fixtures/iscsi/configfs-*.manifest`) with one line per node:
 *
 *     D <relative path>
 *     L <relative path> -> <symlink target>
 *     F <relative path> = <content, `\n` and `\\` escaped>
 *
 * and this helper writes it back out into a real directory, which the
 * path-injectable configfs reader (`services/iscsi-configfs.ts`) is then pointed
 * at. The manifest stays diffable and a reviewer can read the captured values
 * directly, which a tarball or a base64 blob would not allow.
 *
 * Symlink targets are written VERBATIM, dangling and all: LIO's LUN symlinks
 * point at `../../../../../../target/core/<plugin>_<n>/<name>`, which only
 * resolves under the real configfs mount. The reader matches those targets by
 * their tail rather than resolving them — exactly so that this fixture works.
 */

import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** `D <rel>` — a directory. */
const DIR_RE = /^D (.+)$/
/** `L <rel> -> <target>` — a symlink. */
const LINK_RE = /^L (.+?) -> (.*)$/
/** `F <rel> = <escaped content>` — a value file. */
const FILE_RE = /^F (.+?) = (.*)$/

/** A trailing carriage return (CRLF), stripped before matching. */
const TRAILING_CR_RE = /\r$/

/** Undo the manifest's escaping: `\n` → newline, `\\` → backslash. */
function unescapeContent(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const next = s[i + 1]
      if (next === 'n') {
        out += '\n'
        i++
        continue
      }
      if (next === '\\') {
        out += '\\'
        i++
        continue
      }
    }
    out += s[i]
  }
  return out
}

/**
 * Write a manifest out into `destRoot`, creating directories, value files and
 * symlinks. Every configfs value file ends with a newline on the real kernel, so
 * one is appended here too — the readers strip exactly one trailing newline.
 */
export async function materializeConfigfsManifest(manifest: string, destRoot: string): Promise<void> {
  await mkdir(destRoot, { recursive: true })
  const links: { path: string, target: string }[] = []

  for (const rawLine of manifest.split('\n')) {
    const line = rawLine.replace(TRAILING_CR_RE, '')
    if (line.trim() === '')
      continue

    const link = LINK_RE.exec(line)
    if (link) {
      // Deferred: the parent directory may come later in the manifest.
      links.push({ path: join(destRoot, link[1]), target: link[2] })
      continue
    }

    const dir = DIR_RE.exec(line)
    if (dir) {
      await mkdir(join(destRoot, dir[1]), { recursive: true })
      continue
    }

    const file = FILE_RE.exec(line)
    if (file) {
      const path = join(destRoot, file[1])
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `${unescapeContent(file[2])}\n`, 'utf8')
    }
  }

  for (const { path, target } of links) {
    await mkdir(dirname(path), { recursive: true })
    await symlink(target, path)
  }
}
