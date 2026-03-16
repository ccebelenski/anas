#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

if ! sudo virsh domstate "$VM_NAME" 2>/dev/null | grep -q "running"; then
  echo "✓ VM is already stopped"
  exit 0
fi

echo "Sending ACPI shutdown to ${VM_NAME}..."
sudo virsh shutdown "$VM_NAME"

# Wait up to 30 seconds for graceful shutdown
for i in $(seq 1 30); do
  if ! sudo virsh domstate "$VM_NAME" 2>/dev/null | grep -q "running"; then
    echo "✓ VM stopped gracefully"
    exit 0
  fi
  sleep 1
done

echo "⚠ Graceful shutdown timed out. Forcing off..."
sudo virsh destroy "$VM_NAME"
echo "✓ VM forced off"
