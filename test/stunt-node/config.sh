#!/usr/bin/env bash
# Shared configuration for stunt-node scripts.
# Sourced by all scripts — do not execute directly.

VM_NAME="anas-pve"
VM_IP="192.168.200.50"
VM_NETWORK="anas-test"
VM_MAC="52:54:00:a0:a5:01"
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
