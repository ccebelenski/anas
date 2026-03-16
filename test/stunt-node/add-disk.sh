#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

DISK_NUM="${1:?Usage: add-disk.sh <1|2|3>}"

if [[ ! "$DISK_NUM" =~ ^[1-3]$ ]]; then
  echo "ERROR: Disk number must be 1, 2, or 3"
  exit 1
fi

DISK_PATH="${STORAGE_PATH}/${VM_NAME}-hot${DISK_NUM}.qcow2"
SERIAL="ANAS_HOT${DISK_NUM}"

# Create disk image on demand if it doesn't exist
if [ ! -f "$DISK_PATH" ]; then
  echo "Creating hot${DISK_NUM} disk image..."
  qemu-img create -f qcow2 "$DISK_PATH" 512M
fi

# sda=system, sdb=cdrom, so hot disks start at sdc
TARGET="sd$(printf "\\x$(printf '%02x' $((98 + DISK_NUM)))")"

echo "Attaching hot${DISK_NUM} to ${VM_NAME} as ${TARGET}..."
sudo virsh attach-disk "$VM_NAME" \
  "$DISK_PATH" \
  "$TARGET" \
  --driver qemu \
  --subdriver qcow2 \
  --targetbus scsi \
  --serial "$SERIAL" \
  --live

echo "✓ hot${DISK_NUM} attached as ${TARGET} (serial: ${SERIAL})"
