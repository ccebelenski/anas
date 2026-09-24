#!/usr/bin/env bash
# Shared configuration for pbs-node scripts.
# Sourced by all scripts — do not execute directly.

VM_NAME="anas-pbs"
VM_IP="192.168.200.51"
VM_GATEWAY="192.168.200.1"
VM_NETWORK="anas-test"
VM_MAC="52:54:00:a0:a5:02"
VM_USER="root"
VM_PASS="anas-test"
VM_VCPUS=2
VM_RAM=4096
VM_HOSTNAME="anas-pbs"

# Disks
SYSTEM_DISK_SIZE="20G"
STORE_DISK_SIZE="30G"
# Serial → /dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_<serial> inside the VM.
STORE_SERIAL="ANAS_PBS_STORE"

# PBS harness — what ANAS registers as a backup repository
PBS_PORT=8007
PBS_DATASTORE="gtstore"
PBS_DATASTORE_PATH="/mnt/datastore/gtstore"
PBS_TOKEN_ID="root@pam!anas"

SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5"
SSH_CMD="ssh ${SSH_OPTS} ${VM_USER}@${VM_IP}"
SCP_CMD="scp ${SSH_OPTS}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# STORAGE_PATH is host-local and shared with the stunt node — read it from the
# stunt node's config.local (written by test/stunt-node/setup-host.sh) so the
# host is set up once, for both VMs.
STUNT_LOCAL="${SCRIPT_DIR}/../stunt-node/config.local"
if [ -f "$STUNT_LOCAL" ]; then
  source "$STUNT_LOCAL"
fi

# pbs-node's own local file: STORAGE_PATH override plus the generated secrets
# (PBS_TOKEN_SECRET, PBS_FINGERPRINT — written by provision-pbs.sh). Gitignored.
if [ -f "${SCRIPT_DIR}/config.local" ]; then
  source "${SCRIPT_DIR}/config.local"
fi

if [ -z "${STORAGE_PATH:-}" ]; then
  echo "ERROR: STORAGE_PATH not set. Run ../stunt-node/setup-host.sh first" >&2
  echo "       (or set STORAGE_PATH in test/pbs-node/config.local)." >&2
  exit 1
fi
