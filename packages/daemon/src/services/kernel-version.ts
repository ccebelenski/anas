import { release } from 'node:os'

/**
 * Running-kernel capability checks.
 *
 * ANAS gates on the KERNEL, never on the PVE version. The two are not
 * interchangeable: PVE 9 shipped with kernel 6.14.8, so a fully supported,
 * fully up-to-date node can be running a kernel that lacks a feature ANAS
 * needs. "Any supported PVE qualifies" is exactly the kind of claim that is
 * wrong the moment a distro rebases — if there is a feature requirement, check
 * for the feature's kernel.
 */

/** A parsed kernel version — only the two components that gate features. */
export interface KernelVersion {
  major: number
  minor: number
}

/**
 * md gained configurable logical block size in 6.19. Below it, an array whose
 * LBS is not the kernel default is refused at assembly:
 *   `md: array will not be assembled in old kernels that lack configurable
 *    LBS support (<= 6.18)`
 */
export const MD_MIXED_LBS_MIN_KERNEL: KernelVersion = { major: 6, minor: 19 }

/** `6.14.8-1-pve` → `{ major: 6, minor: 14 }`. Null when it does not parse. */
const RELEASE_RE = /^(\d+)\.(\d+)(?:\D|$)/

/**
 * Parse a `uname -r` string. Tolerates every real-world suffix form
 * (`-1-pve`, `-8-pve`, `-generic`, a bare `6.19`), and returns null for
 * anything it cannot read rather than guessing a number.
 */
export function parseKernelVersion(kernelRelease: string): KernelVersion | null {
  const m = RELEASE_RE.exec(kernelRelease.trim())
  if (!m)
    return null
  const major = Number.parseInt(m[1], 10)
  const minor = Number.parseInt(m[2], 10)
  if (!Number.isFinite(major) || !Number.isFinite(minor))
    return null
  return { major, minor }
}

/** `a >= b` on (major, minor). */
function atLeast(a: KernelVersion, b: KernelVersion): boolean {
  return a.major !== b.major ? a.major > b.major : a.minor >= b.minor
}

/** The running kernel's release string (`uname -r`). */
export function runningKernelRelease(): string {
  return release()
}

/** The running kernel, as the layout planner consumes it. */
export interface KernelInfo {
  /** The release string, quoted verbatim to the operator — never paraphrased. */
  release: string
  /** Whether md on this kernel can assemble an array with a non-default LBS. */
  supportsMixedLbs: boolean
}

/**
 * Describe a kernel for the mixed-LBS gate.
 *
 * FAIL-SAFE DIRECTION, deliberate: an UNPARSEABLE release reads as NOT
 * supported. The gate guards an operation that wipes disks, and its whole
 * premise is that mixed-LBS behavior below 6.19 is unproven — so "we could not
 * establish that this kernel is new enough" must land on refuse, not proceed.
 * The refusal names the string we could not parse, so the operator can see
 * immediately that the problem is ANAS's reading and not their hardware.
 */
export function kernelInfo(kernelRelease: string = runningKernelRelease()): KernelInfo {
  const parsed = parseKernelVersion(kernelRelease)
  return {
    release: kernelRelease,
    supportsMixedLbs: parsed !== null && atLeast(parsed, MD_MIXED_LBS_MIN_KERNEL),
  }
}

/** `6.19` — the floor, for operator-facing messages. */
export const MD_MIXED_LBS_MIN_KERNEL_TEXT = `${MD_MIXED_LBS_MIN_KERNEL.major}.${MD_MIXED_LBS_MIN_KERNEL.minor}`
