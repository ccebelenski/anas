#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# ahrcache.1 live-proof fixture — the three virtual disks the AHR read-cache
# spec owns, and nothing else.
#
#   hot7, hot8   1024 MB each → the AHR-1 pool `gtcache` (one RAID1 band)
#   hot9          512 MB      → the cache disk
#
# The review-fix spec adds a FOURTH disk, hot10 (200 MB), as the foreign-PV
# shape: a partition `pvcreate`d and `vgextend`ed into the pool VG by hand, on
# a disk ANAS never labelled. It is attached only by `attach-foreign` and
# cleaned up (pvremove → zap → wipe) and detached by `detach-foreign` — the
# same teardown the review proof does by hand after destroy, kept here so
# `down` leaves the node blank even when a run died with the PV still in the
# VG.
#
# The POOL is NOT built here: creating it any way but the daemon's own API
# would dodge the code under proof — the spec creates and destroys `gtcache`
# through POST/DELETE /v1/ahr, and attaches/detaches the cache through
# POST/DELETE /v1/ahr/gtcache/cache. This script only makes the DISKS present.
#
# Real disks, not loop devices: a loop device has no /dev/disk/by-id entry, and
# the daemon addresses AHR disks exclusively by by-id (shared DiskId).
#
# `hot9.qcow2` may already exist on the host at a different size, carrying
# stale labels from an earlier ground-truth run — `up` therefore RECREATES the
# image when it is not attached, so the cache disk always starts blank.
#
# Disks 1–6 belong to other tests; pools gtbackup/gtiscsi belong to the node.
# Neither is touched here.

POOL="gtcache"
BAND_DISKS=(7 8)
BAND_SIZE_MB=1024
CACHE_DISK=9
CACHE_SIZE_MB=512
FOREIGN_DISK=10
FOREIGN_SIZE_MB=200

by_id() { echo "scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT$1"; }
image_of() { echo "${STORAGE_PATH}/${VM_NAME}-hot$1.qcow2"; }

usage() {
  echo "Usage: ahrcache-fixture.sh <up|down|status|pull-cache|return-cache|restart-daemon>"
  echo "  up             Attach hot${BAND_DISKS[0]}+hot${BAND_DISKS[1]} (${BAND_SIZE_MB} MB) and hot${CACHE_DISK} (${CACHE_SIZE_MB} MB), blank, and wait for their by-id links"
  echo "  down           Best-effort ${POOL} teardown (cache, mounts, fstab, LVM/md, GPTs) + detach all three disks"
  echo "  status         What the node currently has"
  echo "  pull-cache     Yank hot${CACHE_DISK} LIVE, keeping its image (the slice-2 failure path)"
  echo "  return-cache   Re-attach the SAME hot${CACHE_DISK} image, stale PV label and all"
  echo "  attach-foreign Attach hot${FOREIGN_DISK} (${FOREIGN_SIZE_MB} MB), blank — the operator-disk shape"
  echo "  detach-foreign Wipe hot${FOREIGN_DISK} clean (pvremove/zap/wipefs) and detach it"
  echo "  stop-band      Unmount '${POOL}', deactivate the VG, stop its band md array (cache SSD healthy)"
  echo "  restore-band   Reassemble the band, activate the VG, mount from fstab"
  echo "  restart-daemon Restart anasd on the node and wait for its socket (the boot rung)"
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

# Attach one disk at the given size, from a FRESH image. An image left over
# from a previous run can carry a stale GPT, md superblocks or a foreign
# LVM/zfs signature — and a stale signature is exactly what makes `pvcreate`
# abort non-interactively (GT-18), which would fail the attach for a reason
# that has nothing to do with the code under proof.
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
  ids=$(for n in "${BAND_DISKS[@]}" "$CACHE_DISK"; do by_id "$n"; done | tr '\n' ' ')
  $SSH_CMD "bash -s" <<REMOTE || true
umount /mnt/anas-ahr/${POOL} 2>/dev/null || true
umount /mnt/anas-ahr-snapshots/${POOL} 2>/dev/null || true
if vgs ${POOL} >/dev/null 2>&1; then
  lvconvert -y --uncache ${POOL}/${POOL}-vol 2>/dev/null || true
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
  for n in "${BAND_DISKS[@]}" "$CACHE_DISK"; do
    if attached "$n"; then
      "$SCRIPT_DIR/remove-disk.sh" "$n"
    else
      echo "✓ hot${n} not attached (skipping)"
    fi
  done
}

# Best-effort wipe of the foreign-PV disk and detach of it. Runs AFTER
# teardown_pool so the VG (if any) is already gone and `pvremove` sees a PV
# with no volume group — the exact state destroy leaves a foreign PV in.
teardown_foreign() {
  local id
  id="$(by_id "$FOREIGN_DISK")"
  $SSH_CMD "bash -s" <<REMOTE || true
for p in /dev/disk/by-id/${id}-part*; do
  [ -e "\$p" ] && pvremove -ff -y "\$p" 2>/dev/null || true
  [ -e "\$p" ] && mdadm --zero-superblock "\$p" 2>/dev/null || true
  [ -e "\$p" ] && wipefs -a "\$p" 2>/dev/null || true
done
[ -e /dev/disk/by-id/${id} ] && sgdisk --zap-all /dev/disk/by-id/${id} 2>/dev/null || true
[ -e /dev/disk/by-id/${id} ] && wipefs -a /dev/disk/by-id/${id} 2>/dev/null || true
udevadm settle 2>/dev/null || true
REMOTE
}

detach_foreign() {
  if attached "$FOREIGN_DISK"; then
    "$SCRIPT_DIR/remove-disk.sh" "$FOREIGN_DISK"
  else
    echo "✓ hot${FOREIGN_DISK} not attached (skipping)"
  fi
}

case "$1" in
  up)
    echo "=== ahrcache.1 fixture — up ==="
    for n in "${BAND_DISKS[@]}"; do
      attach_blank "$n" "$BAND_SIZE_MB"
    done
    attach_blank "$CACHE_DISK" "$CACHE_SIZE_MB"
    echo
    echo "=== disks ready (pool '${POOL}' and its cache are the spec's business, via /v1/ahr) ==="
    ;;

  down)
    echo "=== ahrcache.1 fixture — down ==="
    teardown_pool
    teardown_foreign
    detach_disks
    detach_foreign
    ;;

  # ---- slice 2: the failure path -----------------------------------------
  # The cache device dies UNDER A LIVE POOL. `remove-disk.sh` is a live virsh
  # detach and the image is left exactly as it is — which is the point: the
  # disk comes back later carrying an outdated PV label ("WARNING: outdated PV
  # … seqno"), the state a real returning SSD is in, and the attach/repair path
  # has to wipe it rather than trip over it.
  pull-cache)
    echo "=== ahrcache.1 fixture — pull the cache disk LIVE ==="
    if attached "$CACHE_DISK"; then
      "$SCRIPT_DIR/remove-disk.sh" "$CACHE_DISK"
      # No settle to wait for: the point of the rung under proof is that udev
      # raises the removal event in the same second the kernel does.
      echo "✓ hot${CACHE_DISK} detached live (image kept at $(image_of "$CACHE_DISK"))"
    else
      echo "✓ hot${CACHE_DISK} not attached (nothing to pull)"
    fi
    ;;

  return-cache)
    echo "=== ahrcache.1 fixture — the cache disk comes back ==="
    # add-disk.sh reuses an existing image, so this is the SAME disk with the
    # SAME serial and the SAME stale label — never a fresh one.
    "$SCRIPT_DIR/add-disk.sh" --size "$CACHE_SIZE_MB" "$CACHE_DISK"
    wait_for_by_id "$(by_id "$CACHE_DISK")"
    ;;

  # ---- slice 2: the boot rung --------------------------------------------
  # The daemon-start scan is what recovers a pool whose cache PV is missing at
  # activation. Restarting anasd with the cache disk already pulled reproduces
  # exactly that, without rebooting the node.
  restart-daemon)
    echo "=== ahrcache.1 fixture — restart anasd ==="
    $SSH_CMD "systemctl restart anasd" || { echo "ERROR: could not restart anasd" >&2; exit 1; }
    # The GATEWAY has to be started back explicitly. `anas.service` carries
    # `Requires=anasd.service`, so stopping or restarting anasd deactivates the
    # gateway with it and systemd does NOT bring it back (restart propagation
    # needs `PartOf=`/`BindsTo=`, which the unit does not have). At a real boot
    # both units start from `multi-user.target` and this never shows; it shows
    # only when the boot rung is REPRODUCED by restarting the daemon, and it
    # cost the first run of the boot-rung test a 502 from pveproxy's ANAS hook
    # ("ANAS gateway not reachable on the loopback interface"). `start` is
    # idempotent and leaves an already-running gateway alone.
    $SSH_CMD "systemctl start anas" || { echo "ERROR: could not start the anas gateway" >&2; exit 1; }
    for n in $(seq 1 30); do
      if $SSH_CMD "test -S /run/anas/anasd.sock && systemctl is-active --quiet anas"; then
        echo "✓ anasd listening and the gateway up again (after ${n}s)"
        exit 0
      fi
      sleep 1
    done
    echo "ERROR: anasd socket and/or the anas gateway never came back" >&2
    exit 1
    ;;

  # ---- review-fix proof: the foreign-PV shape -----------------------------
  # A disk the OPERATOR put a PV on, in the pool's VG, without ANAS ever
  # labelling it. Attached blank; the spec does the sgdisk/pvcreate/vgextend
  # by hand on the node (that hand-work IS the shape), and detach-foreign is
  # the cleanup after destroy has deliberately left the PV standing.
  attach-foreign)
    echo "=== ahrcache.1 fixture — attach hot${FOREIGN_DISK} (${FOREIGN_SIZE_MB} MB, blank) ==="
    attach_blank "$FOREIGN_DISK" "$FOREIGN_SIZE_MB"
    ;;

  detach-foreign)
    echo "=== ahrcache.1 fixture — wipe and detach hot${FOREIGN_DISK} ==="
    teardown_foreign
    detach_foreign
    ;;

  # ---- review-fix proof: the band-down shape ------------------------------
  # The cache SSD stays attached and healthy; the BAND is what goes down —
  # the shape whose cached LV cannot activate because its PV is a stopped md
  # array. What the boot rung must NOT do with that volume is uncache it and
  # announce a missing SSD that is sitting right there. restore-band is the
  # operator's way back (the same three steps, in the same order).
  stop-band)
    echo "=== ahrcache.1 fixture — unmount '${POOL}', deactivate the VG, stop its band array ==="
    $SSH_CMD "bash -s" <<REMOTE
umount /mnt/anas-ahr/${POOL} 2>/dev/null || true
umount /mnt/anas-ahr-snapshots/${POOL} 2>/dev/null || true
vgchange -an ${POOL} 2>/dev/null || true
for md in /dev/md/${POOL}-*; do
  [ -e "\$md" ] || continue
  mdadm --stop "\$md" && echo "✓ stopped \$md" || echo "✗ could not stop \$md"
done
REMOTE
    ;;

  restore-band)
    echo "=== ahrcache.1 fixture — reassemble the band, activate the VG, mount ==="
    $SSH_CMD "bash -s" <<REMOTE
mdadm --assemble --scan 2>/dev/null || true
vgchange -ay ${POOL} 2>/dev/null || true
udevadm settle 2>/dev/null || true
mountpoint -q /mnt/anas-ahr/${POOL} || mount /mnt/anas-ahr/${POOL}
findmnt -n -o TARGET /mnt/anas-ahr/${POOL} 2>/dev/null || echo "NOT MOUNTED"
REMOTE
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
