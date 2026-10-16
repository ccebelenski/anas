#!/usr/bin/env bash
# Wave-2b node pass: the node's state at the start and the end of the pass
# (ADOCK's pieces and /etc/mdadm/mdadm.conf read, never changed).
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
node 'echo "--- date"; date -u; echo "authkey mtime $(stat -c %Y /etc/pve/authkey.pub) now $(date +%s)"
echo "--- ls /anas /adock"; ls /anas /adock 2>&1
echo "--- pct list"; pct list; pct status 9900; pct config 9900 | grep -aE "^(protection|onboot|tags|description|hostname)"
echo "--- adock units"; systemctl is-active adock adockd 2>&1; systemctl list-units --no-legend "adock*" 2>&1
echo "--- zpool"; zpool list -H -o name,health; zfs list -H -o name -t all | grep -c . ; zpool import 2>&1 | grep pool:
echo "--- lvm/md/loop/dm"; vgs 2>&1; grep ^md /proc/mdstat; losetup -a; dmsetup ls
echo "--- /etc/lvm/archive count"; ls /etc/lvm/archive | wc -l
echo "--- mdadm.conf (full sha256 + ARRAY lines)"; sha256sum /etc/mdadm/mdadm.conf; grep -c ^ARRAY /etc/mdadm/mdadm.conf; grep ^ARRAY /etc/mdadm/mdadm.conf
echo "--- disks"; lsblk -d -o NAME,SERIAL | grep -v loop
echo "--- remote mounts / nft / exports"; findmnt -t nfs,nfs4,cifs; nft list tables; exportfs -v
echo "--- config hashes"; for f in /etc/fstab /etc/exports /etc/samba/smb.conf /etc/udev/rules.d/99-anas-cache.rules /usr/share/perl5/PVE/APIServer/AnyEvent.pm /usr/share/perl5/PVE/APIServer/AnasProxy.pm /usr/share/pve-manager/index.html.tpl /etc/pve/user.cfg; do echo "$(sha256sum $f 2>&1 | cut -c1-12) $f"; done
echo "--- pve users"; pveum user list --output-format json | python3 -c "import json,sys; print(sorted(u[\"userid\"] for u in json.load(sys.stdin)))"
echo "--- local accounts in the share band"; getent passwd | awk -F: "\$3>=1000 && \$3<=60000"; getent group | awk -F: "\$3>=1000 && \$3<=60000"
echo "--- misc"; ls /etc/exports.d 2>&1; ls /mnt /srv; echo "failed units:"; systemctl --failed --no-legend; dpkg -l targetcli-fb strace lsof pv 2>&1 | grep "^ii" | cut -c1-40; wc -c < /etc/anas/rclone.conf
echo "--- services"; systemctl is-active anasd anas adock adockd pveproxy pvedaemon; systemctl show -p MainPID,NRestarts anasd anas pveproxy; curl -s --unix-socket /run/anas/anasd.sock -H "x-anas-privileges: Sys.Audit" http://localhost/v1/health; echo'
for p in anas adock; do echo "$p $(curl -sk -o /dev/null -w '%{http_code}' "https://192.168.200.50:8006/$p/")"; done
