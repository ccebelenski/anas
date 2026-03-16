#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

DISK_NUM="${1:?Usage: remove-disk.sh <1|2|3>}"

if [[ ! "$DISK_NUM" =~ ^[1-3]$ ]]; then
  echo "ERROR: Disk number must be 1, 2, or 3"
  exit 1
fi

# Match the target device from add-disk.sh
TARGET="sd$(printf "\\x$(printf '%02x' $((97 + DISK_NUM)))")"

echo "Detaching hot${DISK_NUM} from ${VM_NAME}..."
sudo virsh detach-disk "$VM_NAME" "$TARGET" --live

echo "✓ hot${DISK_NUM} detached"
