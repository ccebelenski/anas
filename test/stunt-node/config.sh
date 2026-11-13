#!/usr/bin/env bash
# Shared configuration for stunt-node scripts.
# Sourced by all scripts — do not execute directly.

# Which stunt node the scripts act on. `pve` (default) is the original node:
# Debian cloud image + PVE packages, ext4 root. `zfs` is the ZFS-root node built
# from the PVE installer ISO by create-zfs-vm.sh (rpool/ROOT/pve-1 at `/`).
# Select with the environment: `STUNT_NODE=zfs ./start.sh`.
# The names must not share a prefix: destroy-vm.sh removes `${VM_NAME}-*` images.
# 192.168.200.51 and MAC ...:02 belong to the PBS test VM (anas-pbs).
STUNT_NODE="${STUNT_NODE:-pve}"
case "$STUNT_NODE" in
  pve)
    VM_NAME="anas-pve"
    VM_IP="192.168.200.50"
    VM_MAC="52:54:00:a0:a5:01"
    ;;
  zfs)
    VM_NAME="anas-zfs"
    VM_IP="192.168.200.52"
    VM_MAC="52:54:00:a0:a5:03"
    ;;
  *)
    echo "ERROR: unknown STUNT_NODE '${STUNT_NODE}' (pve or zfs)" >&2
    exit 1
    ;;
esac
VM_NETWORK="anas-test"
VM_GATEWAY="192.168.200.1"
VM_USER="root"
VM_PASS="anas-test"
VM_VCPUS=4
VM_RAM=4096
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5"
SSH_CMD="ssh ${SSH_OPTS} ${VM_USER}@${VM_IP}"
SCP_CMD="scp ${SSH_OPTS}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Source developer-local overrides
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/config.local" ]; then
  source "${SCRIPT_DIR}/config.local"
else
  echo "ERROR: config.local not found. Run ./setup-host.sh first." >&2
  exit 1
fi
