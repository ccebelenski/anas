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
  zpoolStatus: () => fixtureResult('zfs', 'zpool-status-online.json'),
  zpoolGetAll: (_pool: string) => fixtureResult('zfs', 'zpool-get-all.json'),
  zfsList: () => fixtureResult('zfs', 'zfs-list.json'),
  lsblk: () => fixtureResult('system', 'lsblk.json'),
  diskByIdListing: () => fixtureResult('system', 'disk-by-id.txt'),
  smartctl: () => fixtureResult('system', 'smartctl.json'),
}
