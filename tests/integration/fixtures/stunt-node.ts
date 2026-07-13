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
 * Get the output of a command for verification.
 */
export async function getZpoolStatus(pool: string): Promise<string> {
  return sshExec(`zpool status ${pool}`)
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
