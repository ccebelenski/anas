#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

SNAPSHOT_NAME="${1:?Usage: snapshot.sh <name>}"

echo "Taking snapshot '${SNAPSHOT_NAME}'..."

# Stop VM if running (offline snapshots for full consistency)
if sudo virsh domstate "$VM_NAME" 2>/dev/null | grep -q "running"; then
  echo "Stopping VM for consistent snapshot..."
  "${SCRIPT_DIR}/stop.sh"
fi

sudo virsh snapshot-create-as "$VM_NAME" "$SNAPSHOT_NAME" "Snapshot: ${SNAPSHOT_NAME}"
echo "✓ Snapshot '${SNAPSHOT_NAME}' created"
