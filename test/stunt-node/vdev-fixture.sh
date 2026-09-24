#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# vdevs.1 / vdevs.2 live-proof fixture — disposable state on the stunt node
# (GitHub #66).
#
# Builds:
#   gtvdev  a throwaway pool carrying all SIX vdev classes, one partition each,
#           on the hot disk 9 (serial ANAS_HOT9, by-id
#           scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9, kernel /dev/sdk):
#             <D>1 data   <D>2 log       <D>3 cache
#             <D>4 spare  <D>5 special   <D>6 dedup
#           The pool is built BY CLI on purpose: this story proves the DISPLAY
#           side (the zpool-status parser over the pool-level logs/l2cache/
#           spares/special/dedup sections), not the composer. Disks 1-8,
#           gtbackup and gtiscsi are never touched.
#
# Three shapes of the same pool, one verb each — all six leaves always live on
# the SAME disk, which is the point of the by-id shape:
#   up        leaves named by KERNEL device (/dev/sdX1 …). `zpool status` then
#             carries no by-id anywhere.
#   up-byid   the same six classes created from /dev/disk/by-id/<id>-partN, so
#             every leaf is a by-id PARTITION. The whole-disk identity the
#             parser derives (the `-partN` stripped) is then the SAME string
#             for all six — the production layout of #66, where a request
#             naming the disk names both the log and the cache.
#   up-multi  one data leaf, TWO cache leaves and TWO spares (by-id), the shape
#             that proves a pool-level section holding more than one bare leaf.
#
# `down` is the safety net for all three: destroy gtvdev if present, wipe disk 9
# (labels + GPT), detach it. Every verb is idempotent.

POOL="gtvdev"
DISK_NUM=9
BY_ID="scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT${DISK_NUM}"
IMAGE="${STORAGE_PATH}/${VM_NAME}-hot${DISK_NUM}.qcow2"

usage() {
  echo "Usage: vdev-fixture.sh <up|up-byid|up-multi|down|status>"
  echo "  up        Attach disk ${DISK_NUM} (2048 MB), partition it into six, create pool ${POOL} from KERNEL names (idempotent)"
  echo "  up-byid   The same six classes, created from /dev/disk/by-id/<id>-partN (idempotent)"
  echo "  up-multi  data + TWO cache leaves + TWO spares, by-id (idempotent)"
  echo "  down      Destroy ${POOL} if present, wipe disk ${DISK_NUM}, detach it (idempotent)"
  echo "  status    The pool's zpool status + the disk's by-id links"
  exit 1
}

[ $# -eq 1 ] || usage

pool_exists() { $SSH_CMD "zpool list -H ${POOL}" >/dev/null 2>&1; }

# Wait (bounded) for the disk's by-id link to appear ON THE NODE — attach is
# live hotplug, and udev needs a moment to name it.
wait_for_by_id() {
  local n
  $SSH_CMD "udevadm settle" >/dev/null 2>&1 || true
  for n in $(seq 1 30); do
    if $SSH_CMD "test -e /dev/disk/by-id/${BY_ID}"; then
      echo "✓ /dev/disk/by-id/${BY_ID} present"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: /dev/disk/by-id/${BY_ID} never appeared on the node" >&2
  return 1
}

# Detach disk 9 (only when attached — virsh detach-disk errors otherwise).
detach_disk() {
  if sudo virsh domblklist "$VM_NAME" 2>/dev/null | grep -qF "$IMAGE"; then
    "$SCRIPT_DIR/remove-disk.sh" "$DISK_NUM"
  else
    echo "✓ hot${DISK_NUM} not attached (skipping)"
  fi
}

status() {
  if pool_exists; then
    echo "--- zpool status ${POOL} ---"
    $SSH_CMD "zpool status ${POOL}"
    echo
    echo "--- by-id links ---"
    $SSH_CMD "ls -l /dev/disk/by-id/ | grep '${BY_ID#scsi-0QEMU_QEMU_HARDDISK_}'" || true
  else
    echo "no fixture pool (${POOL})"
  fi
}

# Partition disk 9 into six and create ${POOL} in ONE remote shell so the
# partition table is fresh when the pool lands (a crashed earlier run left no
# pool but may have left a stale table — zap it first). $1 is the `zpool
# create` tail, with @D standing for the device prefix the leaves hang off:
# the kernel device for `up`, the by-id path for the by-id shapes.
create_pool() {
  local tail="$1" prefix="$2"
  $SSH_CMD "bash -s" <<REMOTE
set -euo pipefail
D=\$(readlink -f /dev/disk/by-id/${BY_ID})
sgdisk -Z "\$D"
sgdisk -n1:0:+400M -n2:0:+200M -n3:0:+200M -n4:0:+400M -n5:0:+300M -n6:0:0 "\$D"
udevadm settle
P="${prefix}"
zpool create -f ${POOL} ${tail}
REMOTE
}

case "$1" in
  up)
    echo "=== vdevs.1 fixture — up (kernel names) ==="

    "$SCRIPT_DIR/add-disk.sh" --size 2048 "$DISK_NUM"
    wait_for_by_id

    if pool_exists; then
      echo "✓ ${POOL} already exists (skipping — 'down' first for a rebuild)"
    else
      create_pool '"${P}1" log "${P}2" cache "${P}3" spare "${P}4" special "${P}5" dedup "${P}6"' '$D'
      echo "✓ ${POOL} created (six classes on six partitions of ${BY_ID}, kernel names)"
    fi

    echo
    echo "=== Fixture ready ==="
    status
    ;;

  up-byid)
    echo "=== vdevs.2 fixture — up-byid (by-id partition leaves) ==="

    "$SCRIPT_DIR/add-disk.sh" --size 2048 "$DISK_NUM"
    wait_for_by_id

    if pool_exists; then
      echo "✓ ${POOL} already exists (skipping — 'down' first for a rebuild)"
    else
      create_pool '"${P}-part1" log "${P}-part2" cache "${P}-part3" spare "${P}-part4" special "${P}-part5" dedup "${P}-part6"' "/dev/disk/by-id/${BY_ID}"
      echo "✓ ${POOL} created (six classes as by-id partitions of ${BY_ID})"
    fi

    echo
    echo "=== Fixture ready ==="
    status
    ;;

  up-multi)
    echo "=== vdevs.2 fixture — up-multi (two cache leaves, two spares) ==="

    "$SCRIPT_DIR/add-disk.sh" --size 2048 "$DISK_NUM"
    wait_for_by_id

    if pool_exists; then
      echo "✓ ${POOL} already exists (skipping — 'down' first for a rebuild)"
    else
      create_pool '"${P}-part1" log "${P}-part2" cache "${P}-part3" "${P}-part6" spare "${P}-part4" "${P}-part5"' "/dev/disk/by-id/${BY_ID}"
      echo "✓ ${POOL} created (data + two cache leaves + two spares, by-id)"
    fi

    echo
    echo "=== Fixture ready ==="
    status
    ;;

  down)
    echo "=== vdevs.1 fixture — down ==="
    if pool_exists; then
      $SSH_CMD "zpool destroy ${POOL}"
      echo "✓ ${POOL} destroyed"
    else
      echo "✓ ${POOL} not present (skipping)"
    fi
    # Wipe the disk (labels + GPT) so it comes back blank. Tolerates the
    # never-attached state (no by-id link).
    $SSH_CMD "bash -s" <<REMOTE || true
D=\$(readlink -f /dev/disk/by-id/${BY_ID} 2>/dev/null || true)
if [ -n "\$D" ]; then
  wipefs -a "\$D"
  sgdisk -Z "\$D"
fi
udevadm settle
REMOTE
    detach_disk
    ;;

  status)
    status
    ;;

  *)
    usage
    ;;
esac
