#!/usr/bin/env bash
# cr3.lunrestore.filemark review D2: does the restore mark (trusted.anas.restore)
# travel with an image file? Run ON a stunt node as root; it works only inside
# the scratch it creates and removes it at the end.
#   travel-capture.sh zfs    on anas-zfs  (scratch dataset rpool/filemarkgt)
#   travel-capture.sh pve    on anas-pve  (scratch directory /mnt/filemarkgt)
# Output: travel.anas-zfs.txt / travel.anas-pve.txt. Every command is printed
# as `$ <command>` before its output and `exit=<n>` after it. The mark is read
# with the daemon's own argv (`getfattr --absolute-names -e hex -n
# trusted.anas.restore -- <file>`); the value set is `{}` (0x7b7d).
set -u
N=trusted.anas.restore
run() { printf '$ %s\n' "$*"; eval "$*" 2>&1; printf 'exit=%s\n' "$?"; }
mark() { run "setfattr -n $N -v 0x7b7d -- '$1'"; }
read_mark() { run "getfattr --absolute-names -e hex -n $N -- '$1'"; }

if [ "${1:-}" = zfs ]; then
  B=rpool/filemarkgt
  echo "### anas-zfs $(zfs version | head -1) $(uname -r)"
  run "zfs create -p $B/a && zfs create $B/b"
  run "findmnt -n -o TARGET,FSTYPE,SOURCE --target /$B/a; findmnt -n -o TARGET,FSTYPE,SOURCE --target /$B/b; stat -c '%d %n' /$B/a /$B/b"
  run "truncate -s 1M /$B/a/img.raw"
  mark "/$B/a/img.raw"

  echo "## mv across filesystems (dataset a -> dataset b, two mounts)"
  run "cp -a /$B/a/img.raw /$B/a/mv.raw && mv /$B/a/mv.raw /$B/b/mv.raw"
  read_mark "/$B/b/mv.raw"

  echo "## the .zfs/snapshot copy, plain zfs send | zfs recv, zfs clone"
  run "zfs snapshot $B/a@s1"
  read_mark "/$B/a/.zfs/snapshot/s1/img.raw"
  run "zfs send $B/a@s1 | zfs recv $B/recvd"
  read_mark "/$B/recvd/img.raw"
  run "zfs clone $B/a@s1 $B/clone"
  read_mark "/$B/clone/img.raw"

  echo "## zfs rollback: a mark removed after the snapshot comes back"
  run "setfattr -x $N -- /$B/a/img.raw"
  read_mark "/$B/a/img.raw"
  run "zfs rollback $B/a@s1"
  read_mark "/$B/a/img.raw"

  echo "## zfs rollback: a mark set after the snapshot goes"
  run "truncate -s 1M /$B/a/late.raw"
  run "zfs snapshot $B/a@s2"
  mark "/$B/a/late.raw"
  read_mark "/$B/a/late.raw"
  run "zfs rollback $B/a@s2"
  read_mark "/$B/a/late.raw"

  echo "## cleanup"
  run "zfs destroy -R $B"
  exit 0
fi

if [ "${1:-}" = pve ]; then
  M=/mnt/filemarkgt
  echo "### anas-pve $(uname -r)"
  run "mkdir -p $M/ext4 $M/btrfs && truncate -s 512M $M/btrfs.img && mkfs.btrfs -q $M/btrfs.img && mount -o loop $M/btrfs.img $M/btrfs"
  run "findmnt -n -o TARGET,FSTYPE --target $M/ext4; findmnt -n -o TARGET,FSTYPE --target $M/btrfs"
  run "truncate -s 1M $M/ext4/img.raw"
  mark "$M/ext4/img.raw"

  echo "## across filesystems, ext4 -> btrfs: cp, cp -a, rsync, rsync -aX, mv"
  run "cp $M/ext4/img.raw $M/btrfs/cp.raw"
  read_mark "$M/btrfs/cp.raw"
  run "cp -a $M/ext4/img.raw $M/btrfs/cp-a.raw"
  read_mark "$M/btrfs/cp-a.raw"
  run "rsync $M/ext4/img.raw $M/btrfs/rsync.raw"
  read_mark "$M/btrfs/rsync.raw"
  run "rsync -aX $M/ext4/img.raw $M/btrfs/rsync-aX.raw"
  read_mark "$M/btrfs/rsync-aX.raw"
  run "cp -a $M/ext4/img.raw $M/ext4/mv.raw && mv $M/ext4/mv.raw $M/btrfs/mv.raw"
  read_mark "$M/btrfs/mv.raw"

  echo "## across filesystems, btrfs -> ext4: mv"
  run "mv $M/btrfs/mv.raw $M/ext4/mv-back.raw"
  read_mark "$M/ext4/mv-back.raw"

  echo "## btrfs snapshots of a subvolume holding a marked image (read-write and read-only)"
  run "btrfs subvolume create $M/btrfs/sv"
  run "truncate -s 1M $M/btrfs/sv/img.raw"
  mark "$M/btrfs/sv/img.raw"
  run "btrfs subvolume snapshot $M/btrfs/sv $M/btrfs/sv-snap"
  read_mark "$M/btrfs/sv-snap/img.raw"
  run "btrfs subvolume snapshot -r $M/btrfs/sv $M/btrfs/sv-rosnap"
  read_mark "$M/btrfs/sv-rosnap/img.raw"

  echo "## cleanup"
  run "umount $M/btrfs && rm -rf $M"
  exit 0
fi
echo "usage: $0 zfs|pve" >&2
exit 2
