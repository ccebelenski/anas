#!/usr/bin/env bash
# Wave-3b row 4 (nf.2 D5): a throwaway pool w3r4 with a data disk, a log, a
# cache and a spare (hot disks 20–23, 512 MB each, created for the pass), made
# through the API; Destroy with cleanup. The confirm must list only the data
# (and log) leaves as "Disks to wipe" and name the cache and spare as kept; the
# job must wipe exactly those.
#
#   r4-cleanup-leaves.sh disks-up | create | destroy | disks-down
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
STUNT="$(cd "$(dirname "$0")/../../../test/stunt-node" && pwd)"
ID=scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT
sigs() {
  node "for n in 20 21 22 23; do d=/dev/disk/by-id/${ID}\$n; echo \"  hot\$n: \$(lsblk -nro NAME \$d | tr '\n' ' ')\"; for p in \$(lsblk -nro PATH \$d); do printf '    wipefs -n %-10s ' \$p; wipefs -n --noheadings -O TYPE,LABEL,UUID \$p 2>&1 | sort | uniq -c | tr -s ' ' | tr '\n' ';'; echo; done; done"
}
case "${1:-}" in
  disks-up)
    for n in 20 21 22 23; do "$STUNT/add-disk.sh" "$n" 2>&1 | grep -v 'Permanently added'; done
    node "udevadm settle; ls -l /dev/disk/by-id/ | grep -E 'HOT2[0-3] '" ;;
  create)
    r=$(api POST /pools "{\"name\":\"w3r4\",\"dataVdevs\":[{\"type\":\"stripe\",\"disks\":[\"${ID}20\"]}],\"logVdevs\":[{\"type\":\"stripe\",\"disks\":[\"${ID}21\"]}],\"cacheDisks\":[\"${ID}22\"],\"spareDisks\":[\"${ID}23\"]}")
    echo "$r"; c=$(code_of "$r")
    if [ -n "$c" ]; then r=$(api POST /pools "{\"name\":\"w3r4\",\"dataVdevs\":[{\"type\":\"stripe\",\"disks\":[\"${ID}20\"]}],\"logVdevs\":[{\"type\":\"stripe\",\"disks\":[\"${ID}21\"]}],\"cacheDisks\":[\"${ID}22\"],\"spareDisks\":[\"${ID}23\"]}" -H "x-anas-confirm: $c"); echo "$r"; fi
    wait_job "$(job_of "$r")" 120
    node "zpool status w3r4"
    say "signatures before the destroy"; sigs ;;
  destroy)
    say "Destroy with cleanup: challenge, resend"
    confirmed DELETE '/pools/w3r4?cleanup=true'
    if [ -n "${CONFIRMED_JOB:-}" ]; then wait_job "$CONFIRMED_JOB" 120; echo "$LAST_JOB"; fi
    node "zpool list w3r4 2>&1 | tail -1"
    say "signatures after the destroy"; sigs ;;
  sigs) sigs ;;
  disks-down)
    node "for n in 20 21 22 23; do d=\$(readlink -e /dev/disk/by-id/${ID}\$n) && { wipefs -a \$d >/dev/null; sgdisk -Z \$d >/dev/null; }; done; udevadm settle"
    for n in 20 21 22 23; do "$STUNT/remove-disk.sh" "$n" 2>&1 | grep -v 'Permanently added'; done
    for n in 20 21 22 23; do rm -f "/zfspool/vmimages/anas-pve-hot$n.qcow2"; done
    ls /zfspool/vmimages | grep -E 'hot2[0-3]' || echo "  hot20-23 images deleted" ;;
  *) echo "usage: see header"; exit 2 ;;
esac
