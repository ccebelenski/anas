#!/usr/bin/env bash
set -euo pipefail

# Attach a batch of small spare disks for exercising multi-disk pool operations
# (create mirror/raidz, add-vdev, attach/replace). Spares are named ANAS_HOT<n>
# so the integration fixtures' listSpareDisks() picks them up automatically.
#
# Usage: add-spare-disks.sh [count] [start-index] [size-MB]
#   count       how many disks to add (default 12)
#   start-index first ANAS_HOT<n> index (default 4 — HOT1/2/3 are used elsewhere)
#   size-MB     per-disk size (default 100 — spares only need to hold a label)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

COUNT="${1:-12}"
START="${2:-4}"
SIZE_MB="${3:-100}"

echo "=== Adding ${COUNT} spare disks (ANAS_HOT${START}..$((START + COUNT - 1)), ${SIZE_MB}M each) ==="
for i in $(seq "$START" "$((START + COUNT - 1))"); do
  "${SCRIPT_DIR}/add-disk.sh" --size "$SIZE_MB" "$i" | tail -1
done
echo "✓ Done. Spares visible via: ls /dev/disk/by-id/ | grep ANAS_HOT"
