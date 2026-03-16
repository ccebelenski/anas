#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

echo "=== ANAS Stunt Node — Destroy VM ==="
echo
echo "This will permanently delete:"
echo "  - VM: ${VM_NAME}"
echo "  - All disk images in ${STORAGE_PATH}/${VM_NAME}-*"
echo "  - All snapshots"
echo

read -rp "Type 'destroy' to confirm: " confirm
if [ "$confirm" != "destroy" ]; then
  echo "Aborted."
  exit 1
fi

# Stop if running
if sudo virsh domstate "$VM_NAME" 2>/dev/null | grep -q "running"; then
  echo "Stopping VM..."
  sudo virsh destroy "$VM_NAME" || true
fi

# Delete snapshots
echo "Removing snapshots..."
for snap in $(sudo virsh snapshot-list "$VM_NAME" --name 2>/dev/null); do
  sudo virsh snapshot-delete "$VM_NAME" "$snap" 2>/dev/null || true
done

# Undefine VM
echo "Undefining VM..."
sudo virsh undefine "$VM_NAME" --remove-all-storage 2>/dev/null || sudo virsh undefine "$VM_NAME" 2>/dev/null || true

# Remove disk images and cloud-init ISO
echo "Removing disk images..."
rm -f "${STORAGE_PATH}/${VM_NAME}"-*.qcow2
rm -f "${STORAGE_PATH}/${VM_NAME}"-cloud-init.iso

echo
echo "✓ VM destroyed"
echo
echo "Note: The anas-test network and cached cloud image are left in place."
echo "To remove network: sudo virsh net-destroy anas-test && sudo virsh net-undefine anas-test"
