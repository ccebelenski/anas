/**
 * AHR path conventions (Epic 11 + AHR, docs/AHR-DESIGN.md §2.6) — a LEAF
 * module: pure string math, no imports, no exec, no fs.
 *
 * These three live apart from ahr-create.ts on purpose. Create and destroy both
 * need them, and create must be able to call destroy (the automatic rollback of
 * a failed create, issue #11) — with the helpers still in ahr-create.ts that
 * would be a genuine import cycle between the two mutation services. A leaf
 * module both sides depend on breaks it in the honest direction: shared facts
 * belong below both consumers, not inside one of them.
 */

/** Default base for pool mountpoints (§2.6: pool-scoped, never /mnt/pve). */
export const DEFAULT_AHR_MOUNT_BASE = '/mnt/anas-ahr'

/** The mount base: explicit override > ANAS_AHR_MOUNT_BASE (stunt/tests) > default. */
export function ahrMountBase(override?: string): string {
  return override ?? process.env.ANAS_AHR_MOUNT_BASE ?? DEFAULT_AHR_MOUNT_BASE
}

/** The LV device path of a pool (`/dev/<pool>/<pool>-vol`). */
export function ahrLvPath(name: string): string {
  return `/dev/${name}/${name}-vol`
}
