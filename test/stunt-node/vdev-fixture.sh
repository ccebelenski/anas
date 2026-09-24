#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# vdevs.1 live-proof fixture — disposable state on the stunt node (GitHub #66).
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
# `up` attaches disk 9 (host side), partitions it on the node, and creates
# gtvdev. `down` is the safety net: destroy gtvdev if present, wipe disk 9
# (labels + GPT), detach it. Both verbs are idempotent.

POOL="gtvdev"
DISK_NUM=9
BY_ID="scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT${DISK_NUM}"
IMAGE="${STORAGE_PATH}/${VM_NAME}-hot${DISK_NUM}.qcow2"

usage() {
  echo "Usage: vdev-fixture.sh <up|down|status>"
  echo "  up      Attach disk ${DISK_NUM} (2048 MB), partition it into six, create pool ${POOL} (idempotent)"
  echo "  down    Destroy ${POOL} if present, wipe disk ${DISK_NUM}, detach it (idempotent)"
  echo "  status  The pool's zpool status + the disk's by-id links"
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

case "$1" in
  up)
    echo "=== vdevs.1 fixture — up ==="

    "$SCRIPT_DIR/add-disk.sh" --size 2048 "$DISK_NUM"
    wait_for_by_id

    if pool_exists; then
      echo "✓ ${POOL} already exists (skipping — 'down' first for a rebuild)"
    else
      # Partition and create the pool in ONE remote shell so the partition
      # table is fresh when the pool lands (a crashed earlier run left no
      # pool but may have left a stale table — zap it first).
      $SSH_CMD "bash -s" <<REMOTE
set -euo pipefail
D=\$(readlink -f /dev/disk/by-id/${BY_ID})
sgdisk -Z "\$D"
sgdisk -n1:0:+400M -n2:0:+200M -n3:0:+200M -n4:0:+400M -n5:0:+300M -n6:0:0 "\$D"
udevadm settle
zpool create -f ${POOL} "\${D}1" log "\${D}2" cache "\${D}3" spare "\${D}4" special "\${D}5" dedup "\${D}6"
REMOTE
      echo "✓ ${POOL} created (six classes on six partitions of ${BY_ID})"
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
