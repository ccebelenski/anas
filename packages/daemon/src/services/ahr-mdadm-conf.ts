import type { MdadmArrayPin } from '../parsers/mdadm-conf.js'
import {
  parseMdadmConfDoc,
  removeArray,
  serializeMdadmConfDoc,
  upsertArray,
  upsertProgram,
} from '../parsers/mdadm-conf.js'
import { editConfig } from './config-writer.js'

/**
 * AHR mdadm.conf pinning + monitor-hook wiring (AHR-DESIGN §2.6 / §7.2).
 *
 * ARRAY pins make /dev/md/<pool>-r<band> names deterministic across assembly
 * paths (GT-3: the symlink otherwise flips to a homehost-prefixed form across
 * boots); the PROGRAM line points mdadm --monitor's out-of-the-box mdmonitor
 * service (GT-11) at the ANAS event hook — event-driven, zero polling.
 *
 * This service is PURE config editing: every mutation goes through
 * editConfig() (per-file lock, conflict detection, .bak, atomic replace) with
 * the round-trip mdadm-conf parser, so foreign ARRAY lines, MAILADDR,
 * comments, and everything else ANAS does not manage survive byte-for-byte.
 * It never runs commands — see ARRAY_PIN_REQUIRES_INITRAMFS.
 */

/** Production conf path (Debian). Overridable via ANAS_MDADM_CONF for tests/stunt. */
export const DEFAULT_MDADM_CONF = '/etc/mdadm/mdadm.conf'

/** Where the installer places the md-event hook (packaging/anas-md-event.sh). */
export const ANAS_MD_EVENT_HOOK = '/usr/local/bin/anas-md-event'

/**
 * After ANY mdadm.conf change the initramfs copy is stale — early-boot
 * assembly reads the conf baked into the initramfs, so the caller (the
 * mutation executor / job layer) MUST run `update-initramfs -u` after calling
 * into this service. It is deliberately NOT run here: this service is pure
 * config editing, and the executor owns command side effects (and their
 * audit-logged job context).
 */
export const ARRAY_PIN_REQUIRES_INITRAMFS = true

function resolveConfPath(override?: string): string {
  return override ?? process.env.ANAS_MDADM_CONF ?? DEFAULT_MDADM_CONF
}

/**
 * Pin a pool's arrays: add-or-update one canonical ARRAY line per array,
 * keyed by UUID. Surgical — untouched lines are preserved byte-for-byte.
 * No-op (no write, no .bak) when `arrays` is empty or nothing changes.
 */
export async function pinArrays(arrays: MdadmArrayPin[], path?: string): Promise<void> {
  if (arrays.length === 0)
    return
  await editConfig(resolveConfPath(path), (current) => {
    const doc = parseMdadmConfDoc(current)
    for (const pin of arrays)
      upsertArray(doc, pin)
    return serializeMdadmConfDoc(doc)
  })
}

/**
 * Remove the ARRAY lines for the given UUIDs (pool destroy). Foreign ARRAY
 * lines — any UUID not listed — are never touched. No-op for absent UUIDs.
 */
export async function unpinArrays(uuids: string[], path?: string): Promise<void> {
  if (uuids.length === 0)
    return
  await editConfig(resolveConfPath(path), (current) => {
    const doc = parseMdadmConfDoc(current)
    for (const uuid of uuids)
      removeArray(doc, uuid)
    return serializeMdadmConfDoc(doc)
  })
}

/**
 * Point mdadm --monitor's PROGRAM at the ANAS md-event hook. Idempotent when
 * already installed; throws MdadmForeignProgramError (from the parser) if a
 * PROGRAM line already points somewhere else — mdadm allows exactly one, and
 * ANAS never overwrites a hook it does not own.
 */
export async function installProgramHook(hookPath: string = ANAS_MD_EVENT_HOOK, confPath?: string): Promise<void> {
  await editConfig(resolveConfPath(confPath), (current) => {
    const doc = parseMdadmConfDoc(current)
    upsertProgram(doc, hookPath)
    return serializeMdadmConfDoc(doc)
  })
}
