#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

SNAPSHOT_NAME="${1:?Usage: restore.sh <name>}"

echo "Restoring snapshot '${SNAPSHOT_NAME}'..."

# Stop VM if running
if sudo virsh domstate "$VM_NAME" 2>/dev/null | grep -q "running"; then
  echo "Stopping VM..."
  "${SCRIPT_DIR}/stop.sh"
fi

sudo virsh snapshot-revert "$VM_NAME" "$SNAPSHOT_NAME"
echo "✓ Snapshot '${SNAPSHOT_NAME}' restored"

echo "Starting VM..."
exec "${SCRIPT_DIR}/start.sh"
