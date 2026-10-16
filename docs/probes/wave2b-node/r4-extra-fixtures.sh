#!/usr/bin/env bash
# Row 4: the fixtures run 1 found missing (class (c)), made for the re-run and removed after.
#   spares:   two NEW blank 512 MB hot disks, hot3 and hot16 (pool-composer, pools-act-api/-ui need
#             >= 2 spare disks); images created here and deleted at down
#   datapool: pve-managed-pools' `datapool` — a pool on a 1 GiB sparse file under /var/tmp/w2b plus
#             `pvesm add zfspool datapool --pool datapool` (the spec header's own recipe); down removes
#             the storage and the pool; /etc/pve/storage.cfg sha256 printed before and after
# usage: r4-extra-fixtures.sh up|down
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SN="$ROOT/test/stunt-node"
source "$SN/config.sh"
case "${1:-}" in
up)
  node 'sha256sum /etc/pve/storage.cfg'
  for n in 3 16; do "$SN/add-disk.sh" "$n" | tail -1; done
  node 'udevadm settle; sleep 2; for n in 3 16; do wipefs -a /dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT$n; done
mkdir -p /var/tmp/w2b; truncate -s 1G /var/tmp/w2b/datapool.img; zpool create datapool /var/tmp/w2b/datapool.img
pvesm add zfspool datapool --pool datapool; pvesm status | grep datapool; zpool list -H -o name'
  ;;
down)
  node 'pvesm remove datapool; zpool destroy datapool; rm -f /var/tmp/w2b/datapool.img; sha256sum /etc/pve/storage.cfg; zpool list -H -o name'
  for n in 3 16; do "$SN/remove-disk.sh" "$n" | tail -1; rm -f "${STORAGE_PATH}/${VM_NAME}-hot$n.qcow2"; done
  ;;
esac
