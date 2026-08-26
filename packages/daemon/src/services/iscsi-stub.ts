/**
 * Is a fileio backing a PLACEHOLDER? — the one predicate (story `iscsi.8`).
 *
 * A LEAF module: pure arithmetic over facts the caller already has, no exec, no
 * fs, no imports from the iSCSI read/health/repair layers. It lives apart from
 * all three because all three need the same answer and a second copy would drift
 * (the single-source rule):
 *
 *  - `services/iscsi.ts` needs it while BUILDING a LUN, because a stub must be
 *    classified `unresolved` and must never flip its target to `foreign`;
 *  - `services/iscsi-health.ts` needs it to report `stubLuns[]` and `degraded`;
 *  - `services/iscsi-repair.ts` needs it so Repair treats a stub as an ABSENT
 *    backing — recreating a LUN over the placeholder is the one thing repair
 *    must never do.
 *
 * ## What a stub is, and why the obvious detector is not enough
 *
 * Live-proof wave 2, finding F2 (HIGH): `targetctl restore` does not skip a
 * fileio backing whose file is gone — it **creates** it, at the size recorded in
 * `saveconfig.json`, as long as the mountpoint DIRECTORY exists. A filesystem
 * that failed to mount, or mounted late, therefore produces a LUN that is
 * `ACTIVATED`, exactly the right size, carrying exactly the right serial, and
 * full of zeros. The saveconfig ⟷ configfs diff sees nothing wrong, because
 * nothing is missing.
 *
 * So there are two signals, and either one is enough:
 *
 *  1. **`zeroSized`** — `st_size` is 0 while the saved size is greater. ANAS
 *     creates image files with `ftruncate` to their full length
 *     (`createSparseImage`), so a real image — however sparse, however empty —
 *     always reports its full `st_size`. Only LIO's placeholder is 0.
 *  2. **`wrongMount`** — the filesystem that actually contains the file is not
 *     the mountpoint of the dataset or AHR pool the path belongs to. That is the
 *     case a size check alone cannot catch: a ZFS child dataset that did not
 *     mount leaves its parent dataset holding the placeholder, and if anything
 *     ever wrote to that placeholder it would have a non-zero size while still
 *     being the wrong file.
 *
 * Both are FAIL-CLOSED-ON-KNOWLEDGE, not fail-closed on suspicion: an unread
 * `st_size` (`actualSize: null`), an unknown expected mount, an unreadable mount
 * table — each simply withholds its signal. A node whose `findmnt` failed must
 * not have its LUNs torn down on a guess.
 *
 * ## Why the two signals are not interchangeable
 *
 * Only their CONJUNCTION licenses deleting the file. A 0-byte file on the wrong
 * filesystem is provably LIO's placeholder and nothing else; a 0-byte file on
 * the RIGHT filesystem could be an image an operator truncated, and a non-empty
 * file on the wrong filesystem holds bytes somebody wrote. Neither is ANAS's to
 * delete — quarantine still unmaps them, which costs nothing and loses nothing.
 */

/** Trailing slashes, stripped before any path comparison. */
const TRAILING_SLASH_RE = /\/+$/

/** `/tank/` and `/tank` are the same mountpoint; `/` stays `/`. */
export function canonicalMount(path: string): string {
  return path.replace(TRAILING_SLASH_RE, '') || '/'
}

/** Everything the verdict needs, all of it already read by the caller. */
export interface StubProbe {
  /** The backing path LIO is serving (`saveconfig` `dev` / configfs `udev_path`). */
  backingPath: string
  /** The LIO plugin. Only `fileio` can ever be a stub — LIO creates no devices. */
  plugin: string
  /** The size the saved configuration records for the backstore. */
  persistedSize: number | null
  /**
   * Does the path resolve at all? A path that is NOT there is an ordinary
   * missing backing — the hole `missingLuns` already reports — not a stub. Only
   * a file that exists can be the wrong file.
   */
  exists: boolean | null
  /** The file's real `st_size`; null when it could not be read. */
  actualSize: number | null
  /** The mountpoint of the ZFS dataset / AHR pool the path belongs to; null when unknown. */
  expectedMount: string | null
  /** The `findmnt` longest-prefix mount that contains the file; null when unknown. */
  containingMount: string | null
}

/** The two signals and the verdict they add up to. */
export interface StubVerdict {
  /** Either signal fired: this backing is a placeholder, not the LUN's data. */
  stub: boolean
  /** Signal 1 — 0 bytes against a persisted size greater than 0. */
  zeroSized: boolean
  /** Signal 2 — the containing mount is not the expected one. */
  wrongMount: boolean
  /**
   * Both signals agree, which is the ONLY licence to remove the file. One signal
   * quarantines the LUN; two identify the file beyond doubt.
   */
  removable: boolean
}

/** Nothing was detectable — the shape every non-fileio backing gets. */
const NOT_A_STUB: StubVerdict = { stub: false, zeroSized: false, wrongMount: false, removable: false }

/**
 * The verdict for one backing. Pure.
 *
 * A `/dev/...` path is never a stub: LIO cannot conjure a device node, and the
 * missing-device case is already the honest hole `missingLuns` reports.
 */
export function fileStubVerdict(probe: StubProbe): StubVerdict {
  if (probe.plugin !== 'fileio')
    return NOT_A_STUB
  if (!probe.backingPath.startsWith('/') || probe.backingPath.startsWith('/dev/'))
    return NOT_A_STUB
  // Gone is gone: an absent file is `missingLuns`' business, and calling it a
  // stub would make the quarantine try to tear down a LUN that is already down.
  if (probe.exists === false)
    return NOT_A_STUB

  const persisted = probe.persistedSize ?? 0
  const zeroSized = probe.actualSize === 0 && persisted > 0

  const wrongMount = probe.containingMount !== null
    && probe.expectedMount !== null
    && canonicalMount(probe.containingMount) !== canonicalMount(probe.expectedMount)

  return {
    stub: zeroSized || wrongMount,
    zeroSized,
    wrongMount,
    removable: zeroSized && wrongMount,
  }
}
