#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

echo "Starting ${VM_NAME}..."

if sudo virsh domstate "$VM_NAME" 2>/dev/null | grep -q "running"; then
  echo "✓ VM is already running"
else
  sudo virsh start "$VM_NAME"
fi

echo "Waiting for SSH..."
for i in $(seq 1 60); do
  if $SSH_CMD true &>/dev/null; then
    echo "✓ SSH available at ${VM_USER}@${VM_IP}"
    exit 0
  fi
  sleep 5
done

echo "ERROR: SSH not available after 5 minutes"
exit 1
