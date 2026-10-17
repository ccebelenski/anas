/**
 * Loads fixture files for the MockExecutor.
 * Used in --mock mode to populate realistic command responses.
 */

import type { ExecResult } from '../executor/types.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadFixture(subdir: string, filename: string): string {
  return readFileSync(join(__dirname, subdir, filename), 'utf-8')
}

function fixtureResult(subdir: string, filename: string): ExecResult {
  return { stdout: loadFixture(subdir, filename), stderr: '', exitCode: 0 }
}

/** Fixture results keyed by command signature, for registering with MockExecutor. */
export const mockFixtures = {
  zpoolList: () => fixtureResult('zfs', 'zpool-list.json'),
  /** `blkid -p <partition>` on a blank slice: exit 0, only PART_ENTRY_* keys (fixtures/zfs/NOTES.md). */
  blkidPBlankPartition: () => fixtureResult('zfs', 'blkid-p-blank-partition.txt'),
  zpoolStatus: () => fixtureResult('zfs', 'zpool-status-online.json'),
  zpoolGetAll: (_pool: string) => fixtureResult('zfs', 'zpool-get-all.json'),
  zfsList: () => fixtureResult('zfs', 'zfs-list.json'),
  zfsGetAll: () => fixtureResult('zfs', 'zfs-get-all.json'),
  zfsGetMedia: () => fixtureResult('zfs', 'zfs-get-media.json'),
  zfsSnapshotsMedia: () => fixtureResult('zfs', 'zfs-snapshots-media.json'),
  lsblk: () => fixtureResult('system', 'lsblk.json'),
  diskByIdListing: () => fixtureResult('system', 'disk-by-id.txt'),
  smartctl: () => fixtureResult('system', 'smartctl.json'),
  /** Raw /etc/exports text for seeding a writable mock file in dev. */
  nfsExportsText: () => loadFixture('nfs', 'etc-exports'),
  /** `zpool iostat -plv` two-sample output for the dashboard telemetry (2.7). */
  zpoolIostat: () => fixtureResult('telemetry', 'zpool-iostat-plv.txt'),
  // --- AHR (Epic 11 + AHR) — the stage-0 pool `ahr0` replayed as dev sample.
  ahrMdstat: () => fixtureResult('ahr', 'mdstat-clean.txt'),
  /** The same two arrays mid-`check` — the periodic md scrub in flight (17 stage 6). */
  ahrMdstatCheck: () => fixtureResult('ahr', 'mdstat-check.txt'),
  ahrMdadmExportR1: () => fixtureResult('ahr', 'mdadm-export-r1.txt'),
  ahrMdadmExportR2: () => fixtureResult('ahr', 'mdadm-export-r2.txt'),
  ahrLsblk: () => fixtureResult('ahr', 'lsblk-ahr0.json'),
  ahrPvs: () => fixtureResult('ahr', 'lvm-pvs.json'),
  ahrVgs: () => fixtureResult('ahr', 'lvm-vgs.json'),
  ahrLvs: () => fixtureResult('ahr', 'lvm-lvs.json'),
  ahrFindmnt: () => fixtureResult('ahr', 'findmnt-ahr0.json'),
  ahrBtrfsUsage: () => fixtureResult('ahr', 'btrfs-usage.txt'),
  /**
   * One case of the `timeout 2 stat -f` capture (mounts/stat-f-exit-codes.txt,
   * story 18.1), replayed: `heading` is the text after `### `. The exit code
   * is the case's `EXIT=` line; its output goes to stdout on exit 0 and to
   * stderr otherwise (a failing stat prints only its error). cr.35's share
   * path check runs the same probe.
   */
  statF: (heading: string): ExecResult => statFCase(heading),
}

/** The `EXIT=<n>` line closing each case of stat-f-exit-codes.txt. */
const EXIT_LINE_RE = /^EXIT=(\d+)/

function statFCase(heading: string): ExecResult {
  const lines = loadFixture('mounts', 'stat-f-exit-codes.txt').split('\n')
  const start = lines.indexOf(`### ${heading}`)
  if (start < 0)
    throw new Error(`stat-f-exit-codes.txt has no case '### ${heading}'`)
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    const exit = EXIT_LINE_RE.exec(line)
    if (exit) {
      const exitCode = Number(exit[1])
      const text = out.length > 0 ? `${out.join('\n')}\n` : ''
      return exitCode === 0 ? { stdout: text, stderr: '', exitCode } : { stdout: '', stderr: text, exitCode }
    }
    if (!line.startsWith('$ '))
      out.push(line)
  }
  throw new Error(`stat-f-exit-codes.txt case '${heading}' has no EXIT= line`)
}
