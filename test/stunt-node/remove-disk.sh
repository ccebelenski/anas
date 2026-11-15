#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

usage() {
  echo "Usage: remove-disk.sh [--nvme] <n>"
  echo "  <n>     Disk index (1,2,… — must match the add-disk.sh index; 0 is the cdrom, never valid)"
  echo "  --nvme  Detach NVMe device (default: SCSI)"
  exit 1
}

BUS="scsi"
DISK_NUM=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --nvme) BUS="nvme"; shift ;;
    [1-9]|[1-9][0-9]) DISK_NUM="$1"; shift ;;
    *)      usage ;;
  esac
done

[ -z "$DISK_NUM" ] && usage

# Hot-plug is serialised per VM: add-disk.sh and remove-disk.sh take the same
# lock, so two specs (or a fixture and a spec) never have a detach in flight
# while another attach/detach of the same VM starts. `virsh detach-disk --live`
# only ASKS the guest to release the device and returns before it has (the
# first cr3 node pass lost three specs to a re-attach that met a disk still
# going away), so the lock is held until the disk has really left.
HOTPLUG_LOCK="${STORAGE_PATH}/.${VM_NAME}-hotplug.lock"
exec 9>"$HOTPLUG_LOCK"
if ! flock -w 300 9; then
  echo "ERROR: another hot-plug of ${VM_NAME} held ${HOTPLUG_LOCK} for 300 s" >&2
  exit 1
fi

# Wait (up to 60 s) until a probe command stops matching. $1 = what is awaited
# (for the message); the rest is the probe, which succeeds while the device is
# still there.
wait_gone() {
  local what="$1"; shift
  local i
  for i in $(seq 1 120); do
    if ! "$@"; then
      return 0
    fi
    sleep 0.5
  done
  echo "ERROR: ${what} still present on ${VM_NAME} 60 s after the detach" >&2
  return 1
}

if [ "$BUS" = "nvme" ]; then
  CTRL_ID="nvme${DISK_NUM}"

  echo "Detaching NVMe hot${DISK_NUM} from ${VM_NAME}..."

  # Remove NVMe controller (takes the namespace with it)
  sudo virsh qemu-monitor-command "$VM_NAME" --hmp \
    "device_del ${CTRL_ID}"
  # device_del is asynchronous too: the controller leaves when the guest lets
  # go of it. Remove the drive backend only after that.
  wait_gone "NVMe controller ${CTRL_ID}" bash -c \
    "sudo virsh qemu-monitor-command '$VM_NAME' --hmp 'info pci' | grep -qF 'id \"${CTRL_ID}\"'"
  # Remove the drive backend
  sudo virsh qemu-monitor-command "$VM_NAME" --hmp \
    "drive_del drive-${CTRL_ID}"

  echo "✓ hot${DISK_NUM} (NVMe) detached"
else
  # sda=system, sdb=cdrom, so hot disks start at sdc (matching add-disk.sh)
  TARGET="sd$(printf "\\x$(printf '%02x' $((98 + DISK_NUM)))")"

  echo "Detaching SCSI hot${DISK_NUM} from ${VM_NAME}..."
  sudo virsh detach-disk "$VM_NAME" "$TARGET" --live
  # Done only when libvirt no longer lists the target (the guest has released
  # it); a caller that re-attaches the same index right after would otherwise
  # race the unplug.
  wait_gone "SCSI ${TARGET}" bash -c \
    "sudo virsh domblklist '$VM_NAME' | awk '\$1 == \"${TARGET}\"' | grep -q ."

  echo "✓ hot${DISK_NUM} (SCSI) detached"
fi
