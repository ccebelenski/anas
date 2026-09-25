#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# ahrexpand.1 live-proof fixture — the three virtual disks the zero-gain
# expansion-guard spec owns, and nothing else.
#
#   hot7, hot8   2048 MB each → the AHR-1 pool `gtexpand` (one RAID1 band)
#   hot9         4096 MB      → the larger replacement disk
#
# THE SIZES ARE THE POINT. The layout granularity is 1 GiB
# (AHR_SIZE_GRANULARITY_BYTES), so these round to 2/2/4 GiB and give the §5.2
# shape the story is about: replacing one 2 GiB member with a 4 GiB disk forms
# a band [2 GiB, 4 GiB] with ONE member, which AHR-1 cannot protect — physical
# capacity present, usable capacity unchanged, and the plan's own pending
# sentence saying what unlocks it. Adding the freed 2 GiB disk back is then the
# positive-gain counterpart (band 1 goes raid1×2 → raid5×3).
#
# Modelled on ahrcache-fixture.sh, whose disks these are (7/8/9 at other
# sizes): the images are RECREATED at `up`, because an image left over from
# another fixture carries a stale GPT, md superblock or LVM label, and a stale
# signature is exactly what aborts `pvcreate` non-interactively. The POOL is
# never built here — the spec creates and destroys `gtexpand` through the
# daemon's own API, or the code under proof would be dodged.
#
# Disks 1–6 belong to other tests; pools gtbackup/gtiscsi belong to the node.
# Neither is touched here.

POOL="gtexpand"
BAND_DISKS=(7 8)
BAND_SIZE_MB=2048
BIG_DISK=9
BIG_SIZE_MB=4096

by_id() { echo "scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT$1"; }
image_of() { echo "${STORAGE_PATH}/${VM_NAME}-hot$1.qcow2"; }

usage() {
  echo "Usage: ahrexpand-fixture.sh <up|down|status>"
  echo "  up      Attach hot${BAND_DISKS[0]}+hot${BAND_DISKS[1]} (${BAND_SIZE_MB} MB) and hot${BIG_DISK} (${BIG_SIZE_MB} MB), blank"
  echo "  down    Best-effort ${POOL} teardown (mounts, fstab, LVM/md, GPTs) + detach all three disks"
  echo "  status  What the node currently has"
  exit 1
}

[ $# -eq 1 ] || usage

attached() {
  sudo virsh domblklist "$VM_NAME" 2>/dev/null | grep -qF "$(image_of "$1")"
}

# Wait (bounded) for a disk's by-id link to appear ON THE NODE — attach is live
# hotplug, and udev needs a moment to name it.
wait_for_by_id() {
  local id="$1" n
  $SSH_CMD "udevadm settle" >/dev/null 2>&1 || true
  for n in $(seq 1 30); do
    if $SSH_CMD "test -e /dev/disk/by-id/${id}"; then
      echo "✓ /dev/disk/by-id/${id} present"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: /dev/disk/by-id/${id} never appeared on the node" >&2
  return 1
}

# Attach one disk at the given size from a FRESH image. A detached image from
# another fixture is at the wrong size AND carries stale signatures, so it is
# removed rather than reused; an already-attached disk is left alone (the size
# it has is the size the node is using).
attach_blank() {
  local n="$1" size="$2" img
  img="$(image_of "$n")"
  if attached "$n"; then
    echo "✓ hot${n} already attached (leaving it as it is)"
  else
    rm -f "$img"
    "$SCRIPT_DIR/add-disk.sh" --size "$size" "$n"
  fi
  wait_for_by_id "$(by_id "$n")"
}

# Best-effort teardown of anything a crashed spec run can leave behind. The
# destroy THROUGH THE API is the normal path and leaves nothing for this to do.
teardown_pool() {
  local ids
  ids=$(for n in "${BAND_DISKS[@]}" "$BIG_DISK"; do by_id "$n"; done | tr '\n' ' ')
  $SSH_CMD "bash -s" <<REMOTE || true
rm -f /etc/anas/ahr/${POOL}*.json 2>/dev/null || true
umount /mnt/anas-ahr/${POOL} 2>/dev/null || true
umount /mnt/anas-ahr-snapshots/${POOL} 2>/dev/null || true
if vgs ${POOL} >/dev/null 2>&1; then
  lvremove -ff -y ${POOL} 2>/dev/null || true
  vgreduce --removemissing ${POOL} 2>/dev/null || true
  vgremove -ff -y ${POOL} 2>/dev/null || true
fi
for md in /dev/md/${POOL}-*; do mdadm --stop "\$md" 2>/dev/null || true; done
for d in ${ids}; do
  for p in /dev/disk/by-id/\$d-part*; do
    [ -e "\$p" ] && pvremove -ff -y "\$p" 2>/dev/null || true
    [ -e "\$p" ] && mdadm --zero-superblock "\$p" 2>/dev/null || true
    [ -e "\$p" ] && wipefs -a "\$p" 2>/dev/null || true
  done
  [ -e /dev/disk/by-id/\$d ] && sgdisk --zap-all /dev/disk/by-id/\$d 2>/dev/null || true
done
udevadm settle 2>/dev/null || true
if grep -qE 'anas-ahr(-snapshots)?/${POOL}[^a-z-]' /etc/fstab 2>/dev/null; then
  sed -i -E '\#anas-ahr(-snapshots)?/${POOL}#d' /etc/fstab
  systemctl daemon-reload
fi
REMOTE
}

detach_disks() {
  local n
  for n in "${BAND_DISKS[@]}" "$BIG_DISK"; do
    if attached "$n"; then
      "$SCRIPT_DIR/remove-disk.sh" "$n"
    else
      echo "✓ hot${n} not attached (skipping)"
    fi
  done
}

case "$1" in
  up)
    echo "=== ahrexpand.1 fixture — up ==="
    for n in "${BAND_DISKS[@]}"; do
      attach_blank "$n" "$BAND_SIZE_MB"
    done
    attach_blank "$BIG_DISK" "$BIG_SIZE_MB"
    echo
    echo "=== disks ready (pool '${POOL}' is the spec's business, via /v1/ahr) ==="
    ;;

  down)
    echo "=== ahrexpand.1 fixture — down ==="
    teardown_pool
    detach_disks
    ;;

  status)
    echo "--- attached images ---"
    sudo virsh domblklist "$VM_NAME" 2>/dev/null || true
    echo
    echo "--- node: lsblk / lvs / pvs / mdstat ---"
    $SSH_CMD "lsblk -o NAME,SIZE,TYPE,PARTLABEL,SERIAL; echo; lvs; pvs; vgs; cat /proc/mdstat" || true
    ;;

  *)
    usage
    ;;
esac
