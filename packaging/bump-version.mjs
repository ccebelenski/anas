#!/usr/bin/env node
//
// Bump the ANAS version everywhere it lives, from ONE command (story 10.10).
//
// The root package.json is the single source of truth; this script propagates
// a new version to every other copy so they can never drift:
//   - package.json (root)
//   - packages/{shared,daemon,gateway}/package.json
//   - packages/shared/src/index.ts  (the VERSION const the health/status
//     endpoints report)
//   - package-lock.json  (via `npm install --package-lock-only`, so a later
//     `npm ci` in make-release doesn't reject a stale lockfile)
//
// Usage:  node packaging/bump-version.mjs <new-version>
//         npm run version:bump -- <new-version>
//
// make-release.sh independently verifies all copies agree before building.
//
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const newVersion = process.argv[2]
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i
if (!newVersion || !SEMVER.test(newVersion)) {
  console.error('usage: node packaging/bump-version.mjs <new-version>   (semver, e.g. 0.2.0)')
  process.exit(2)
}

const manifests = [
  'package.json',
  'packages/shared/package.json',
  'packages/daemon/package.json',
  'packages/gateway/package.json',
]

const oldVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version

for (const rel of manifests) {
  const path = join(repoRoot, rel)
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  pkg.version = newVersion
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)
  process.stdout.write(`  ${rel}: ${newVersion}\n`)
}

// The VERSION const in shared — a build-time constant, not a runtime fs read.
const indexPath = join(repoRoot, 'packages/shared/src/index.ts')
const index = readFileSync(indexPath, 'utf8')
const VERSION_LINE = /^export const VERSION = '[^']*'$/m
if (!VERSION_LINE.test(index)) {
  console.error(`ERROR: VERSION const not found in ${indexPath} — expected: export const VERSION = '...'`)
  process.exit(1)
}
writeFileSync(indexPath, index.replace(VERSION_LINE, `export const VERSION = '${newVersion}'`))
process.stdout.write(`  packages/shared/src/index.ts: VERSION = '${newVersion}'\n`)

process.stdout.write('  syncing package-lock.json ...\n')
execFileSync('npm', ['install', '--package-lock-only'], { cwd: repoRoot, stdio: 'inherit' })

process.stdout.write(`\n${oldVersion} -> ${newVersion}. Commit, then packaging/make-release.sh will tag v${newVersion}.\n`)
