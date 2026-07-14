import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const SSH_OPTS = [
  '-o',
  'StrictHostKeyChecking=no',
  '-o',
  'UserKnownHostsFile=/dev/null',
  '-o',
  'ConnectTimeout=5',
]
const VM_USER = 'root'
const VM_IP = '192.168.200.50'

/**
 * Execute a command on the stunt node via SSH.
 * Returns stdout.
 */
export async function sshExec(command: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'ssh',
    [...SSH_OPTS, `${VM_USER}@${VM_IP}`, command],
    { timeout: 30_000 },
  )
  return stdout.trim()
}

/**
 * Check if a ZFS pool exists.
 */
export async function poolExists(pool: string): Promise<boolean> {
  try {
    await sshExec(`zpool list ${pool}`)
    return true
  }
  catch {
    return false
  }
}

/**
 * Check if a ZFS dataset exists.
 */
export async function datasetExists(dataset: string): Promise<boolean> {
  try {
    await sshExec(`zfs list ${dataset}`)
    return true
  }
  catch {
    return false
  }
}

/**
 * Best-effort recursive teardown of a throwaway dataset, leaving the box clean
 * for reruns. Never throws — the dataset may already be gone. `-r` removes any
 * children a test staged under it.
 */
export async function destroyDataset(dataset: string): Promise<void> {
  await sshExec(`zfs destroy -r ${dataset}`).catch(() => {})
}

/**
 * Read a single ZFS property value from the real system (source of truth).
 * Uses `-H -o value` for a bare, scriptable scalar (Principle 13).
 */
export async function getDatasetProp(dataset: string, prop: string): Promise<string> {
  return (await sshExec(`zfs get -H -o value ${prop} ${dataset}`)).trim()
}

/**
 * Return a dataset's mountpoint on the real system (e.g. `/testpool/itest`).
 */
export async function getDatasetMountpoint(dataset: string): Promise<string> {
  return getDatasetProp(dataset, 'mountpoint')
}

/**
 * Return `stat -c '%U %G %a' <path>` for a filesystem path — the owner name,
 * group name, and octal mode. Used to verify POSIX permission mutations (4.7).
 */
export async function statOwnership(path: string): Promise<string> {
  return (await sshExec(`stat -c '%U %G %a' ${path}`)).trim()
}

/**
 * Return just the octal mode of a path (`stat -c '%a'`), e.g. `755` or `2755`.
 * The layered permissions editor (4.7.2) maps base levels to mode bits, so this
 * is the source-of-truth check for a base-only change.
 */
export async function getMode(path: string): Promise<string> {
  return (await sshExec(`stat -c '%a' ${path}`)).trim()
}

/**
 * Raw `getfacl -pcE` for a path — the POSIX ACL as the daemon reads it (no
 * header, no #effective comments). Best-effort; returns '' when unreadable so
 * callers can grep it without try/catch.
 */
export async function getfaclText(path: string): Promise<string> {
  try {
    return await sshExec(`getfacl -pcE ${path} 2>/dev/null`)
  }
  catch {
    return ''
  }
}

/**
 * Whether the access ACL of `path` carries a NAMED user entry for `user`
 * (`user:<name>:<perms>`). Skips the base `user::` owner line (empty qualifier)
 * and the inherited `default:user:<name>:` lines — only the live access-ACL
 * named grant counts. Source of truth behind the named-principal grid.
 */
export async function aclHasNamedUser(path: string, user: string): Promise<boolean> {
  const text = await getfaclText(path)
  return text.split('\n').some(l => l.trim().startsWith(`user:${user}:`))
}

/**
 * Reset a throwaway dataset's mountpoint to a pristine baseline for a rerun /
 * teardown: strip every ACL entry (`-b`) and the default ACL (`-k`) WHILE the
 * dataset is still posixacl, restore the default 755 mode, then revert acltype
 * to its inherited value (off). Order matters — setfacl needs posixacl in force,
 * so the `zfs inherit` comes last. Never throws.
 */
export async function resetDatasetAccess(dataset: string, path: string): Promise<void> {
  await sshExec(
    `setfacl -b -k ${path} 2>/dev/null; chmod 755 ${path} 2>/dev/null; `
    + `zfs inherit acltype ${dataset} 2>/dev/null; true`,
  ).catch(() => {})
}

/**
 * Create a throwaway share user on the real system (`useradd -M`, no home, a
 * nologin shell — it exists only to be an ACL principal). Not best-effort: the
 * caller pre-cleans with removeShareUser so this lands a fresh account whose
 * uid falls in the regular-user band and thus surfaces in /identity/users.
 */
export async function createShareUser(name: string): Promise<void> {
  await sshExec(`useradd -M -s /usr/sbin/nologin ${name}`)
}

/**
 * Create a ZFS snapshot directly on the real system (source of truth staging for
 * the snapshot specs — never for the create story itself, which goes through the
 * API). `dataset` is fully-qualified (e.g. 'testpool/share1'), `snap` the bare
 * snapshot name (e.g. 's1'). `-r` recurses into children when requested.
 */
export async function createSnapshot(dataset: string, snap: string, recursive = false): Promise<void> {
  await sshExec(`zfs snapshot ${recursive ? '-r ' : ''}${dataset}@${snap}`)
}

/**
 * Best-effort teardown of a single snapshot, leaving the box clean for reruns.
 * Never throws — the snapshot may already be gone. `-r` also removes the same
 * snapshot on any child datasets (mirrors a recursive create).
 */
export async function destroySnapshot(dataset: string, snap: string): Promise<void> {
  await sshExec(`zfs destroy -r ${dataset}@${snap}`).catch(() => {})
}

/**
 * List the bare snapshot names for a dataset on the real system, e.g. ['s1',
 * 's2']. Uses `-H -o name -t snapshot -d 1` for a bare, scriptable list scoped to
 * the dataset itself (not children). Returns [] when the dataset has none.
 */
export async function listSnapshots(dataset: string): Promise<string[]> {
  try {
    const out = await sshExec(`zfs list -H -o name -t snapshot -d 1 ${dataset}`)
    return out
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .map(fq => fq.split('@')[1])
      .filter(Boolean)
  }
  catch {
    return []
  }
}

/**
 * Check if a specific snapshot (`dataset@snap`) exists on the real system.
 */
export async function snapshotExists(dataset: string, snap: string): Promise<boolean> {
  try {
    await sshExec(`zfs list -t snapshot ${dataset}@${snap}`)
    return true
  }
  catch {
    return false
  }
}

/**
 * Check if an SMB share exists in smb.conf.
 */
export async function smbShareExists(share: string): Promise<boolean> {
  try {
    const output = await sshExec(`grep -c '\\[${share}\\]' /etc/samba/smb.conf`)
    return Number.parseInt(output, 10) > 0
  }
  catch {
    return false
  }
}

/**
 * Check if an NFS export exists.
 */
export async function nfsExportExists(exportPath: string): Promise<boolean> {
  try {
    const output = await sshExec(`grep -c '${exportPath}' /etc/exports`)
    return Number.parseInt(output, 10) > 0
  }
  catch {
    return false
  }
}

/**
 * Best-effort teardown of a throwaway SMB share, leaving smb.conf clean for
 * reruns. Surgically deletes the `[name]` stanza (and its indented body up to the
 * next section or EOF) directly on the real system, then reloads smbd. Never
 * throws — a GREEN create→remove test removes the stanza through the UI, so this
 * is a no-op safety net; it only bites when a test aborts mid-flight.
 */
export async function removeSmbShare(name: string): Promise<void> {
  const py = `import re; p='/etc/samba/smb.conf'; s=open(p).read(); s2=re.sub(r'(?ms)^\\[${name}\\].*?(?=^\\[|\\Z)','',s); open(p,'w').write(s2)`
  await sshExec(`python3 -c "${py}" && systemctl reload smbd 2>/dev/null || true`).catch(() => {})
}

/**
 * Best-effort teardown of a throwaway NFS export, leaving /etc/exports clean for
 * reruns. Deletes any line beginning with the export path, then re-syncs the
 * kernel export table (`exportfs -ra`). Never throws — a `#` sed delimiter keeps
 * the slash-heavy path readable.
 */
export async function removeNfsExport(exportPath: string): Promise<void> {
  await sshExec(`sed -i '\\#^${exportPath}[[:space:]]#d' /etc/exports && exportfs -ra 2>/dev/null || true`).catch(() => {})
}

/**
 * Create a directory on the real system (an NFS export path must exist before
 * `exportfs` will accept it). `-p` is idempotent. Best-effort; never throws.
 */
export async function makeDir(path: string): Promise<void> {
  await sshExec(`mkdir -p ${path}`).catch(() => {})
}

/**
 * Best-effort removal of a directory staged by makeDir. `rmdir` only removes it
 * when empty, so a mistakenly-populated path is left intact. Never throws.
 */
export async function removeDir(path: string): Promise<void> {
  await sshExec(`rmdir ${path}`).catch(() => {})
}

/**
 * Get the output of a command for verification.
 */
export async function getZpoolStatus(pool: string): Promise<string> {
  return sshExec(`zpool status ${pool}`)
}

// ---- Share identities (Epic 8) ------------------------------------------
//
// Source-of-truth probes + best-effort teardown for the Share Users specs.
// Users/groups are resolved via getent (source-agnostic, exactly like the
// daemon) — never by parsing /etc/passwd. Teardown mirrors the daemon's own
// commands in reverse (userdel + smbpasswd -x / groupdel) so a crashed UI run
// leaves no itest_* leftovers.

/**
 * Check whether a user is resolvable on the real system (getent passwd).
 */
export async function shareUserExists(name: string): Promise<boolean> {
  try {
    await sshExec(`getent passwd ${name}`)
    return true
  }
  catch {
    return false
  }
}

/**
 * Check whether a group is resolvable on the real system (getent group).
 */
export async function shareGroupExists(name: string): Promise<boolean> {
  try {
    await sshExec(`getent group ${name}`)
    return true
  }
  catch {
    return false
  }
}

/**
 * Check whether a user has a Samba passdb entry (pdbedit -L) — the source of
 * truth behind the grid's SMB ✓ column.
 */
export async function smbUserExists(name: string): Promise<boolean> {
  try {
    const out = await sshExec(`pdbedit -L 2>/dev/null | cut -d: -f1`)
    return out.split('\n').map(s => s.trim()).includes(name)
  }
  catch {
    return false
  }
}

/**
 * Best-effort teardown of a throwaway share user, leaving the box clean for
 * reruns. Drops the Samba passdb entry first (smbpasswd -x), then removes the
 * account (userdel). Never throws — a GREEN test removes the user through the
 * UI, so this is a no-op safety net that only bites on an aborted run.
 */
export async function removeShareUser(name: string): Promise<void> {
  await sshExec(`smbpasswd -x ${name} 2>/dev/null || true`).catch(() => {})
  await sshExec(`userdel ${name} 2>/dev/null || true`).catch(() => {})
}

/**
 * Best-effort teardown of a throwaway group (groupdel). Never throws.
 */
export async function removeShareGroup(name: string): Promise<void> {
  await sshExec(`groupdel ${name} 2>/dev/null || true`).catch(() => {})
}

/**
 * Whether a user is disabled on the real system. Mirrors the daemon's `locked`
 * derivation exactly: it reads the shadow account-expiry field (getent shadow,
 * 8th colon-field) and treats a past/day-1 value as expired. `disableUser`
 * sets `--expiredate 1`; `enableUser` clears it. Returns false when the field
 * is empty/-1 (never expires) or unreadable.
 */
export async function userDisabled(name: string): Promise<boolean> {
  try {
    const field = (await sshExec(`getent shadow ${name} | cut -d: -f8`)).trim()
    if (field === '' || field === '-1')
      return false
    const days = Number(field)
    if (!Number.isFinite(days) || days < 0)
      return false
    return days <= Math.floor(Date.now() / 86_400_000)
  }
  catch {
    return false
  }
}

/**
 * List the supplementary/primary groups a user belongs to on the real system
 * (`id -nG`), e.g. ['itest_usr', 'itest_grp']. Returns [] when unresolvable.
 */
export async function userGroups(name: string): Promise<string[]> {
  try {
    const out = await sshExec(`id -nG ${name}`)
    return out.split(/\s+/).map(s => s.trim()).filter(Boolean)
  }
  catch {
    return []
  }
}

/**
 * List by-id identifiers of spare (unused) test disks on the stunt node.
 *
 * Only the QEMU 'ANAS_HOT<n>' whole disks are considered — never the boot disk —
 * so an empty result is a safe "no spares" rather than a risk of grabbing rpool.
 * A disk is spare when its real device is NOT claimed by any imported pool, so a
 * disk freed by `destroyPool`/`zpool export` shows up again on the next call
 * (even with stale ZFS labels — `createTestPool` forces past those).
 *
 * Returns e.g. ['scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT3']. The spare-requiring specs
 * `test.skip` cleanly when this is empty — attach more disks with
 * test/stunt-node/add-disk.sh to enable them.
 */
export async function listSpareDisks(): Promise<string[]> {
  let ids: string[]
  try {
    const out = await sshExec('ls /dev/disk/by-id/ 2>/dev/null')
    ids = out
      .split('\n')
      .map(s => s.trim())
      .filter(id =>
        /^scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT\d+$/.test(id)
        || /^nvme-ANAS_HOT\d+$/.test(id),
      )
  }
  catch {
    return []
  }

  // Base device paths (partition suffix stripped) currently claimed by a pool.
  const inUse = new Set<string>()
  try {
    // -L resolves vdev names to real devices, -P prints their full paths.
    const status = await sshExec('zpool status -LP 2>/dev/null || true')
    for (const m of status.matchAll(/\/dev\/\S+/g))
      inUse.add(m[0].replace(/\d+$/, ''))
  }
  catch {
    // No pools / zpool unavailable — treat everything as free.
  }

  const spares: string[] = []
  for (const id of ids) {
    try {
      const dev = (await sshExec(`readlink -f /dev/disk/by-id/${id}`)).trim()
      if (dev && !inUse.has(dev))
        spares.push(id)
    }
    catch {
      // Skip disks we can't resolve.
    }
  }
  return spares
}

/**
 * Create a throwaway ZFS pool from the given by-id disks (a no-redundancy stripe).
 * `-f` forces past stale labels left by a previously destroyed/exported pool.
 * Used only to stage disposable pools for the Act specs — never for the create
 * story itself (that goes through the API).
 */
export async function createTestPool(name: string, diskIds: string[]): Promise<void> {
  const devs = diskIds.map(id => `/dev/disk/by-id/${id}`).join(' ')
  await sshExec(`zpool create -f ${name} ${devs}`)
}

/**
 * Best-effort teardown of a throwaway pool, leaving the box clean for reruns.
 * Handles both states an Act test can leave it in: still imported (destroy) or
 * exported by an export test (import, then destroy). Never throws.
 */
export async function destroyPool(name: string): Promise<void> {
  try {
    await sshExec(`zpool destroy -f ${name}`)
    return
  }
  catch {
    // Not imported — it may be an exported pool still on its disks.
  }
  try {
    await sshExec(`zpool import -f ${name} 2>/dev/null && zpool destroy -f ${name}`)
  }
  catch {
    // Nothing to clean up (or already gone).
  }
}

/**
 * Return the name of the pool holding the boot/root filesystem, or null when the
 * system root is not on ZFS (e.g. an ext4/LVM install). The PROTECTED_RESOURCE
 * destroy test skips when this is null — there is no protected pool to exercise.
 */
export async function getRootPool(): Promise<string | null> {
  try {
    const src = (await sshExec('findmnt -n -o SOURCE / 2>/dev/null || true')).trim()
    // ZFS root looks like 'rpool/ROOT/pve-1'; a block device starts with /dev/.
    if (src && !src.startsWith('/dev/') && src.includes('/'))
      return src.split('/')[0]
  }
  catch {
    // Fall through to the bootfs probe.
  }
  try {
    const bootfs = (await sshExec(
      'zpool get -H -o value bootfs 2>/dev/null | grep -v \'^-$\' | head -n1 || true',
    )).trim()
    if (bootfs && bootfs.includes('/'))
      return bootfs.split('/')[0]
  }
  catch {
    // No ZFS boot pool.
  }
  return null
}
