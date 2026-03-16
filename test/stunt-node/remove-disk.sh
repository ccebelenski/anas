#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

usage() {
  echo "Usage: remove-disk.sh [--nvme] <1|2|3>"
  echo "  --nvme  Detach NVMe device (default: SCSI)"
  exit 1
}

BUS="scsi"
DISK_NUM=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --nvme) BUS="nvme"; shift ;;
    [1-3])  DISK_NUM="$1"; shift ;;
    *)      usage ;;
  esac
done

[ -z "$DISK_NUM" ] && usage

if [ "$BUS" = "nvme" ]; then
  CTRL_ID="nvme${DISK_NUM}"

  echo "Detaching NVMe hot${DISK_NUM} from ${VM_NAME}..."

  # Remove NVMe controller (takes the namespace with it)
  sudo virsh qemu-monitor-command "$VM_NAME" --hmp \
    "device_del ${CTRL_ID}"
  sleep 1
  # Remove the drive backend
  sudo virsh qemu-monitor-command "$VM_NAME" --hmp \
    "drive_del drive-${CTRL_ID}"

  echo "✓ hot${DISK_NUM} (NVMe) detached"
else
  # sda=system, sdb=cdrom, so hot disks start at sdc (matching add-disk.sh)
  TARGET="sd$(printf "\\x$(printf '%02x' $((98 + DISK_NUM)))")"

  echo "Detaching SCSI hot${DISK_NUM} from ${VM_NAME}..."
  sudo virsh detach-disk "$VM_NAME" "$TARGET" --live

  echo "✓ hot${DISK_NUM} (SCSI) detached"
fi
