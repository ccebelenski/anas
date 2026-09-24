#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

SNAPSHOT_NAME="${1:?Usage: restore.sh <name>}"

echo "Restoring snapshot '${SNAPSHOT_NAME}'..."

if sudo virsh domstate "$VM_NAME" 2>/dev/null | grep -q "running"; then
  sudo virsh destroy "$VM_NAME"
fi

sudo virsh snapshot-revert "$VM_NAME" "$SNAPSHOT_NAME" --running
echo "✓ Snapshot restored, VM starting"

"${SCRIPT_DIR}/start.sh"
