#!/usr/bin/env bash
# Wave-3 node pass, N6 (WAVE3-DESIGN §6.4 "needs a node check"): what a
# mutating command leaves when it is KILLED mid-way. Loop devices over sparse
# files under /var/tmp/w3n6 only — never a real disk of the node.
#
# The kill lands at an exact syscall: `strace --inject=<syscall>:signal=SIGKILL:when=N`
# (strace installed for the pass). N is found by a first, uninjected trace of
# the same command on the same kind of device ("map"), then the command is
# re-run with the kill ("kill"), and what is left is recorded ("after").
#
#   n6.sh loops | zc-map | zc-kill <N> | zc-after | md-map | md-kill <N> | md-after
#        | lv-prep | lv-map | lv-kill <N> | lv-after | teardown
set -uo pipefail
source "$(dirname "$0")/lib.sh"
D=/var/tmp/w3n6
case "${1:-}" in
  loops)
    node "mkdir -p $D; for n in a b c d; do truncate -s 256M $D/\$n.img; losetup -fP --show $D/\$n.img > $D/\$n.loop; echo \"\$n=\$(cat $D/\$n.loop)\"; done" ;;
  zc-map)   # zpool create on loop a, traced (ioctl + the partition writes), then undone
    node "A=\$(cat $D/a.loop); strace -f -qq -e trace=ioctl -o $D/zc.trace zpool create -f w3n6a \$A; echo rc=\$?
      echo 'ioctl requests of the zpool process, numbered (per tracee):'; awk '{print \$1, \$3}' $D/zc.trace | grep -n 'ioctl' | grep -E '0x5a00|ZFS_IOC_POOL_CREATE' | head -3
      awk '{print \$1}' $D/zc.trace | sort | uniq -c
      zpool destroy w3n6a; zpool labelclear -f \${A}p1 2>/dev/null; wipefs -a \$A >/dev/null; sgdisk --zap-all \$A >/dev/null; partx -d \$A 2>/dev/null; lsblk -n \$A" ;;
  zc-kill)
    node "A=\$(cat $D/a.loop); strace -qq -e trace=ioctl -e inject=ioctl:signal=SIGKILL:when=$2 -o $D/zc-kill.trace zpool create -f w3n6a \$A; echo rc=\$?; tail -3 $D/zc-kill.trace" ;;
  zc-after)
    node "A=\$(cat $D/a.loop); echo '--- zpool list:'; zpool list -H -o name w3n6a 2>&1; echo '--- lsblk:'; lsblk -o NAME,SIZE,PARTLABEL,FSTYPE \$A; echo '--- blkid -p:'; blkid -p \$A \${A}p1 \${A}p9 2>&1; echo '--- zdb -l on part1 (first lines):'; zdb -l \${A}p1 2>&1 | head -12; echo '--- zpool import (scan of loop a):'; zpool import -d \$A 2>&1 | head -8" ;;
  md-map)
    node "B=\$(cat $D/b.loop); C=\$(cat $D/c.loop); strace -f -qq -e trace=ioctl,openat,write -o $D/md.trace mdadm --create /dev/md/w3n6b --name=w3n6b --level=1 --raid-devices=2 --metadata=1.2 --run --assume-clean \$B \$C; echo rc=\$?
      grep -nE 'ioctl\\(' $D/md.trace | awk '{print NR\": \"\$0}' | grep -E 'RUN_ARRAY|SET_ARRAY_INFO|ADD_NEW_DISK|0x930|0x923|0x921' | cut -c1-160 | head
      grep -nE 'array_state|new_dev|md/' $D/md.trace | cut -c1-160 | head -20
      cat /proc/mdstat | grep -A1 w3n6b; mdadm --stop /dev/md/w3n6b; mdadm --zero-superblock \$B \$C; cat /proc/mdstat | grep -c w3n6b" ;;
  md-kill)  # $2 = syscall name, $3 = when
    node "B=\$(cat $D/b.loop); C=\$(cat $D/c.loop); strace -f -qq -e trace=$2 -e inject=$2:signal=SIGKILL:when=$3 -o $D/md-kill.trace mdadm --create /dev/md/w3n6b --name=w3n6b --level=1 --raid-devices=2 --metadata=1.2 --run --assume-clean \$B \$C; echo rc=\$?; tail -4 $D/md-kill.trace | cut -c1-200" ;;
  md-after)
    node "B=\$(cat $D/b.loop); C=\$(cat $D/c.loop); echo '--- /proc/mdstat:'; cat /proc/mdstat; echo '--- examine:'; for d in \$B \$C; do mdadm --examine \$d 2>&1 | grep -E 'Magic|Name|State|Array UUID|Device Role|^/dev' ; done; echo '--- md devices:'; ls -l /dev/md/ 2>&1; for m in /sys/block/md*/md/array_state; do echo \"\$m=\$(cat \$m)\"; done; grep -c w3n6b /etc/mdadm/mdadm.conf" ;;
  lv-prep)
    node "Dd=\$(cat $D/d.loop); pvcreate -q \$Dd && vgcreate -q w3n6vg \$Dd && lvcreate -q -L 64M -n lv w3n6vg && lvcreate -q -L 32M -n keep w3n6vg && lvs w3n6vg" ;;
  lv-map)  # count the metadata writes an lvremove makes (on a scratch LV, re-created after)
    node "lvcreate -q -L 16M -n map w3n6vg; strace -f -qq -e trace=pwrite64,write,fsync,fdatasync,openat -o $D/lv.trace lvremove -y w3n6vg/map; echo rc=\$?
      grep -nE 'pwrite64|fsync|fdatasync|openat.*(lock|archive|backup|/dev/loop)' $D/lv.trace | cut -c1-170 | head -30" ;;
  lv-kill)  # $2 = syscall, $3 = when
    node "strace -f -qq -e trace=$2 -e inject=$2:signal=SIGKILL:when=$3 -o $D/lv-kill.trace lvremove -y w3n6vg/lv; echo rc=\$?; tail -3 $D/lv-kill.trace | cut -c1-200" ;;
  lv-after)
    node "echo '--- lvs:'; lvs -a w3n6vg 2>&1; echo '--- vgck:'; vgck w3n6vg 2>&1; echo \"vgck rc=\$?\"; echo '--- /run/lock/lvm:'; ls -la /run/lock/lvm 2>&1; echo '--- metadata seqno:'; vgs -o vg_name,vg_seqno w3n6vg 2>&1; echo '--- a second lvremove:'; lvremove -y w3n6vg/lv 2>&1; lvs w3n6vg 2>&1" ;;
  teardown)
    node "vgremove -qq -y w3n6vg 2>/dev/null; zpool destroy w3n6a 2>/dev/null; mdadm --stop /dev/md/w3n6b 2>/dev/null; for n in a b c d; do l=\$(cat $D/\$n.loop 2>/dev/null); [ -n \"\$l\" ] || continue; pvremove -qq -y \$l 2>/dev/null; mdadm --zero-superblock \$l 2>/dev/null; wipefs -a \$l >/dev/null 2>&1; losetup -d \$l; done; rm -rf $D; ls /etc/lvm/archive /etc/lvm/backup 2>&1 | head; losetup -a; cat /proc/mdstat | grep ^md" ;;
  *) echo "usage: see header"; exit 2 ;;
esac
