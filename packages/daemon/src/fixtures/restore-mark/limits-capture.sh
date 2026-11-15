#!/usr/bin/env bash
# cr3.lunrestore.filemark review D2: the README's remaining ground-truth
# sentences, each captured with its command (refusing filesystems, sizes, the
# two-file read, the package). Run ON a stunt node as root; it works only in
# the scratch it creates and removes it at the end.
#   limits-capture.sh zfs    on anas-zfs  (scratch dataset rpool/filemarkgt)
#   limits-capture.sh pve    on anas-pve  (scratch directory /mnt/filemarkgt)
# Output: limits.anas-zfs.txt / limits.anas-pve.txt.
set -u
N=trusted.anas.restore
run() { printf '$ %s\n' "$*"; eval "$*" 2>&1; printf 'exit=%s\n' "$?"; }
read_mark() { run "getfattr --absolute-names -e hex -n $N -- '$1'"; }
sized() { run "setfattr -n $N -v \"\$(head -c $2 /dev/zero | tr '\\0' a)\" -- '$1' && getfattr --only-values --absolute-names -n $N -- '$1' | wc -c"; }
package() {
  echo "## the package"
  run "dpkg -S /usr/bin/setfattr /usr/bin/getfattr"
  run "dpkg-query -W -f='\${Package} \${Version} \${Priority}\n' attr"
  run "echo auto: \$(apt-mark showauto attr); echo manual: \$(apt-mark showmanual attr)"
  run "zgrep -h -E '^(Start-Date|Commandline):' /var/log/apt/history.log* | grep -B1 -E 'Commandline:.* attr( |\$)'"
  run "apt-cache rdepends --installed attr"
  run "apt-cache depends --installed samba xfsprogs | grep -E '^[a-z]|attr\$'"
  run "apt-cache show samba | grep -E '^(Version|Recommends|Suggests):'"
  run "zgrep -h -E ' install (samba|attr|proxmox-ve):' /var/log/dpkg.log*"
}

if [ "${1:-}" = zfs ]; then
  B=rpool/filemarkgt
  echo "### anas-zfs $(zfs version | head -1) $(uname -r)"
  run "zfs create -p -o xattr=off $B/xoff && zfs create $B/xoffafter && zfs create $B/size"
  run "zfs get -H -o name,property,value xattr $B/xoff $B/xoffafter; findmnt -n -o TARGET,OPTIONS --target /$B/xoff"
  echo "## xattr=off: set, read, remove"
  run "truncate -s 1M /$B/xoff/lun0.img"
  run "setfattr -n $N -v 0x7b7d -- /$B/xoff/lun0.img"
  read_mark "/$B/xoff/lun0.img"
  run "setfattr -x $N -- /$B/xoff/lun0.img"
  echo "## a mark set before the dataset is switched to xattr=off"
  run "truncate -s 1M /$B/xoffafter/lun0.img && setfattr -n $N -v 0x7b7d -- /$B/xoffafter/lun0.img && zfs set xattr=off $B/xoffafter"
  run "findmnt -n -o OPTIONS --target /$B/xoffafter"
  read_mark "/$B/xoffafter/lun0.img"
  echo "## two files in one getfattr, one of them missing"
  run "truncate -s 1M /$B/size/a.img /$B/size/b.img && setfattr -n $N -v 0x7b7d -- /$B/size/a.img"
  run "getfattr --absolute-names -e hex -n $N -- /$B/size/a.img /$B/size/b.img /$B/size/gone.img"
  echo "## value sizes on ZFS (xattr=sa)"
  sized "/$B/size/a.img" 65536
  sized "/$B/size/a.img" 65537
  package
  echo "## cleanup"
  run "zfs destroy -R $B"
  exit 0
fi

if [ "${1:-}" = pve ]; then
  M=/mnt/filemarkgt
  echo "### anas-pve $(uname -r)"
  run "mkdir -p $M/ext4 $M/full $M/btrfs && truncate -s 64M $M/full.img && mkfs.ext4 -q -F $M/full.img && mount -o loop $M/full.img $M/full && truncate -s 512M $M/btrfs.img && mkfs.btrfs -q $M/btrfs.img && mount -o loop $M/btrfs.img $M/btrfs"
  run "findmnt -n -o TARGET,FSTYPE --target $M/ext4; tune2fs -l \$(findmnt -n -o SOURCE --target $M/ext4) | grep -E '^(Block size|Inode size):'"
  echo "## value sizes on ext4 (the root filesystem: 4 KiB blocks, 256-byte inodes)"
  run "truncate -s 1M $M/ext4/a.img"
  sized "$M/ext4/a.img" 4032
  sized "$M/ext4/a.img" 4033
  sized "$M/ext4/a.img" 4096
  echo "## value sizes on btrfs"
  run "truncate -s 1M $M/btrfs/a.img"
  sized "$M/btrfs/a.img" 8000
  sized "$M/btrfs/a.img" 65536
  echo "## ext4 filled to its last block (root's reserve included)"
  run "truncate -s 1M $M/full/lun0.img; dd if=/dev/zero of=$M/full/fill bs=64k status=none; sync; df -h $M/full | tail -1"
  run "setfattr -n $N -v 0x7b7d -- $M/full/lun0.img"
  sized "$M/full/lun0.img" 1400
  package
  echo "## cleanup"
  run "umount $M/full && umount $M/btrfs && rm -rf $M"
  exit 0
fi
echo "usage: $0 zfs|pve" >&2
exit 2
