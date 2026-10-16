#!/usr/bin/env bash
# Row 3 (cr.33c) fixture — a HAND-BUILT AHR-1 pool `w2bahr` that never touches /etc/mdadm/mdadm.conf.
# Every ANAS create pins its arrays in mdadm.conf (ahr-create.ts pinArrays) and refreshes the
# initramfs, and the brief forbids editing that file, so the pool is built here with the exact
# commands ahr-create.ts runs MINUS the pin, the initramfs refresh and the fstab line. ANAS adopts it
# by its VG (ahr-topology.ts ownership rule (a): "the matching LVM VG exists — stateless adoption").
#   disks: two NEW hot disks, hot20 + hot21, 1024 MB each (sdv/sdw; images created here, deleted at down)
#   md:    /dev/md/w2bahr-r1, raid1 over -part1 of each, metadata 1.2, --name=w2bahr-r1, internal bitmap
#   LVM:   PV on the md, VG w2bahr, LV w2bahr-vol — every LVM call with
#          --config 'backup{backup=0 archive=0}' so /etc/lvm/archive and /etc/lvm/backup are not written
#   btrfs: -L w2bahr -d single -m dup --sectorsize 4096; subvolumes @data and @snapshots;
#          mounted subvol=@data at /mnt/anas-ahr/w2bahr by hand (no fstab line)
# usage: r3-ahr-fixture.sh up|down|status
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SN="$ROOT/test/stunt-node"
source "$SN/config.sh"
LVMC="--config 'backup{backup=0 archive=0}'"
ids() { echo scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT20 scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT21; }
case "${1:-status}" in
up)
  for n in 20 21; do "$SN/add-disk.sh" --size 1024 $n | tail -1; done
  node "bash -s" <<NODE
set -e
udevadm settle; for i in \$(seq 1 20); do [ -e /dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT21 ] && break; sleep 1; done
for d in $(ids); do D=/dev/disk/by-id/\$d; wipefs -a \$D >/dev/null; sgdisk --zap-all \$D >/dev/null; sgdisk -n 1:0:0 -t 1:FD00 \$D >/dev/null; done
udevadm settle
for d in $(ids); do mdadm --zero-superblock /dev/disk/by-id/\$d-part1 2>/dev/null || true; done
mdadm --create /dev/md/w2bahr-r1 --level=1 --raid-devices=2 --metadata=1.2 --name=w2bahr-r1 --bitmap=internal --run \
  /dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT20-part1 /dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT21-part1
wipefs -a /dev/md/w2bahr-r1
pvcreate $LVMC /dev/md/w2bahr-r1
vgcreate $LVMC w2bahr /dev/md/w2bahr-r1
lvcreate $LVMC -y -l 100%FREE -n w2bahr-vol w2bahr
mkfs.btrfs -q -L w2bahr -d single -m dup --sectorsize 4096 /dev/w2bahr/w2bahr-vol
mkdir -p /mnt/anas-ahr/w2bahr
mount -t btrfs -o subvolid=5 /dev/w2bahr/w2bahr-vol /mnt/anas-ahr/w2bahr
btrfs subvolume create /mnt/anas-ahr/w2bahr/@data; btrfs subvolume create /mnt/anas-ahr/w2bahr/@snapshots
umount /mnt/anas-ahr/w2bahr
mount -t btrfs -o subvol=@data /dev/w2bahr/w2bahr-vol /mnt/anas-ahr/w2bahr
mkdir -p /mnt/anas-ahr/w2bahr/d; head -c 4M /dev/urandom > /mnt/anas-ahr/w2bahr/d/f1
cat /proc/mdstat; findmnt /mnt/anas-ahr/w2bahr; mdadm --detail --export /dev/md/w2bahr-r1
NODE
  ;;
down)
  node "bash -s" <<NODE
umount /mnt/anas-ahr/w2bahr 2>/dev/null; rmdir /mnt/anas-ahr/w2bahr 2>/dev/null
lvremove $LVMC -ff -y w2bahr 2>/dev/null; vgremove $LVMC -ff -y w2bahr 2>/dev/null; pvremove $LVMC -ff -y /dev/md/w2bahr-r1 2>/dev/null
mdadm --stop /dev/md/w2bahr-r1
for d in $(ids); do mdadm --zero-superblock /dev/disk/by-id/\$d-part1 2>/dev/null; wipefs -a /dev/disk/by-id/\$d-part1 2>/dev/null; sgdisk --zap-all /dev/disk/by-id/\$d >/dev/null 2>&1; done
udevadm settle; cat /proc/mdstat; vgs 2>&1 | head -3
NODE
  for n in 20 21; do "$SN/remove-disk.sh" $n | tail -1; rm -f "${STORAGE_PATH}/${VM_NAME}-hot$n.qcow2"; done
  ;;
status)
  node "cat /proc/mdstat; vgs; lvs; findmnt -t btrfs; lsblk -o NAME,SIZE,TYPE,SERIAL | grep -E 'HOT2[01]|md|w2bahr'"
  ;;
esac
