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
