#!/usr/bin/env bash
# Wave-3b node pass: the node's state at the start and the end of the pass
# (ADOCK's pieces read, never changed).
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
node 'echo "--- ls /anas /adock"; ls /anas /adock 2>&1
echo "--- pct list"; pct list; pct config 9900 | grep -aE "^(protection|onboot|tags|description)"
echo "--- zpool"; zpool list -H -o name,health; zpool import 2>&1 | grep pool:
echo "--- lvm/md/loop/dm"; vgs 2>&1; grep ^md /proc/mdstat; losetup -a; dmsetup ls
echo "--- disks"; lsblk -d -o NAME,SERIAL | grep -v loop
echo "--- remote mounts / nft / exports"; findmnt -t nfs,nfs4,cifs; nft list tables; exportfs -v
echo "--- config hashes"; for f in /etc/fstab /etc/exports /etc/samba/smb.conf /etc/mdadm/mdadm.conf /etc/udev/rules.d/99-anas-cache.rules /usr/share/perl5/PVE/APIServer/AnyEvent.pm /usr/share/pve-manager/index.html.tpl; do echo "$(sha256sum $f | cut -c1-12) $f"; done
echo "--- misc"; ls /etc/exports.d 2>&1; ls /mnt /srv; systemctl --failed --no-legend; dpkg -l targetcli-fb strace 2>&1 | grep -c "^ii"; wc -c < /etc/anas/rclone.conf
echo "--- services"; systemctl is-active anasd anas adock adockd pveproxy; curl -s --unix-socket /run/anas/anasd.sock http://localhost/v1/health; echo'
for p in anas adock; do echo "$p $(curl -sk -o /dev/null -w '%{http_code}' "https://192.168.200.50:8006/$p/")"; done
