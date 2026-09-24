#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

echo "=== ANAS PBS Node — Destroy VM ==="
echo
echo "This will permanently delete:"
echo "  - VM: ${VM_NAME}"
echo "  - All disk images in ${STORAGE_PATH}/${VM_NAME}-* (system + datastore)"
echo "  - All snapshots, and every backup stored in ${PBS_DATASTORE}"
echo

read -rp "Type 'destroy' to confirm: " confirm
if [ "$confirm" != "destroy" ]; then
  echo "Aborted."
  exit 1
fi

if sudo virsh domstate "$VM_NAME" 2>/dev/null | grep -q "running"; then
  echo "Stopping VM..."
  sudo virsh destroy "$VM_NAME" || true
fi

echo "Removing snapshots..."
for snap in $(sudo virsh snapshot-list "$VM_NAME" --name 2>/dev/null); do
  sudo virsh snapshot-delete "$VM_NAME" "$snap" 2>/dev/null || true
done

echo "Undefining VM..."
sudo virsh undefine "$VM_NAME" --remove-all-storage 2>/dev/null || sudo virsh undefine "$VM_NAME" 2>/dev/null || true

echo "Removing disk images..."
rm -f "${STORAGE_PATH}/${VM_NAME}"-*.qcow2
rm -f "${STORAGE_PATH}/${VM_NAME}"-cloud-init.iso

# The token secret and fingerprint in config.local no longer refer to anything.
if [ -f "${SCRIPT_DIR}/config.local" ]; then
  sed -i '/^PBS_TOKEN_SECRET=/d;/^PBS_FINGERPRINT=/d' "${SCRIPT_DIR}/config.local"
  echo "✓ Stale credentials cleared from config.local"
fi

echo
echo "✓ VM destroyed"
echo
echo "Note: the anas-test network and cached cloud image are shared with the"
echo "stunt node and are left in place."
