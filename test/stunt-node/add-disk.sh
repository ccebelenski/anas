#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

usage() {
  echo "Usage: add-disk.sh [--nvme] [--size <MB>] <n>"
  echo "  <n>      Disk index (1,2,… → serial ANAS_HOT<n>, by-id scsi-…ANAS_HOT<n>)"
  echo "  --nvme   Attach as NVMe device (default: SCSI)"
  echo "  --size   Image size in MB (default: 512). Spares can be small, e.g. 100."
  exit 1
}

BUS="scsi"
DISK_NUM=""
SIZE_MB="512"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --nvme)  BUS="nvme"; shift ;;
    --size)  SIZE_MB="$2"; shift 2 ;;
    [0-9]|[0-9][0-9]) DISK_NUM="$1"; shift ;;
    *)       usage ;;
  esac
done

[ -z "$DISK_NUM" ] && usage

DISK_PATH="${STORAGE_PATH}/${VM_NAME}-hot${DISK_NUM}.qcow2"
SERIAL="ANAS_HOT${DISK_NUM}"

# Create disk image on demand if it doesn't exist
if [ ! -f "$DISK_PATH" ]; then
  echo "Creating hot${DISK_NUM} disk image (${SIZE_MB}M)..."
  qemu-img create -f qcow2 "$DISK_PATH" "${SIZE_MB}M"
fi

# QEMU runs as 'qemu' user — needs read/write access
chmod 666 "$DISK_PATH"

if [ "$BUS" = "nvme" ]; then
  # NVMe requires QEMU device passthrough — libvirt doesn't support
  # nvme via attach-disk. We add an nvme controller via qemu monitor
  # commands, plugged into a free pcie-root-port.
  CTRL_ID="nvme${DISK_NUM}"
  # Use pci.7, pci.8, pci.9 for nvme disks 1, 2, 3
  PCI_BUS="pci.$((6 + DISK_NUM))"

  echo "Attaching hot${DISK_NUM} to ${VM_NAME} as NVMe on ${PCI_BUS}..."

  # Add a drive backend
  sudo virsh qemu-monitor-command "$VM_NAME" --hmp \
    "drive_add auto \"id=drive-${CTRL_ID},file=${DISK_PATH},format=qcow2,if=none\""

  # Add NVMe controller on a pcie-root-port with serial number
  sudo virsh qemu-monitor-command "$VM_NAME" --hmp \
    "device_add nvme,id=${CTRL_ID},drive=drive-${CTRL_ID},serial=${SERIAL},bus=${PCI_BUS}"

  echo "✓ hot${DISK_NUM} attached as NVMe (serial: ${SERIAL})"
  echo "  Inside VM: /dev/nvme*  (by-id: nvme-${SERIAL}*)"
else
  # SCSI: sda=system, sdb=cdrom, so hot disks start at sdc
  TARGET="sd$(printf "\\x$(printf '%02x' $((98 + DISK_NUM)))")"

  echo "Attaching hot${DISK_NUM} to ${VM_NAME} as ${TARGET} (SCSI)..."
  sudo virsh attach-disk "$VM_NAME" \
    "$DISK_PATH" \
    "$TARGET" \
    --driver qemu \
    --subdriver qcow2 \
    --targetbus scsi \
    --serial "$SERIAL" \
    --live

  echo "✓ hot${DISK_NUM} attached as ${TARGET} (serial: ${SERIAL})"
  echo "  Inside VM: /dev/${TARGET}  (by-id: scsi-0QEMU_QEMU_HARDDISK_${SERIAL})"
fi
