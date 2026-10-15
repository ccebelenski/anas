#!/bin/bash
# Wave-3 design pass (M1 executor timeouts): READ-ONLY timing probe.
# Runs each command the daemon uses for reads N times on the node and prints
# min/median/max wall-clock ms plus the last exit code. Nothing here writes,
# imports, creates, sets or restarts anything; `zpool import` with no
# arguments only scans devices and lists what could be imported.
# Usage (from the dev host): ssh root@<node> 'bash -s' < timing.sh
N=${N:-7}
t() {
  local label="$1"; shift
  local times=() rc=0 i s e
  for i in $(seq 1 "$N"); do
    s=$(date +%s%N)
    "$@" >/dev/null 2>&1; rc=$?
    e=$(date +%s%N)
    times+=( $(( (e - s) / 1000000 )) )
  done
  local sorted
  sorted=($(printf '%s\n' "${times[@]}" | sort -n))
  printf '%-62s rc=%-3s min=%6sms med=%6sms max=%6sms\n' "$label" "$rc" "${sorted[0]}" "${sorted[$((N / 2))]}" "${sorted[$((N - 1))]}"
}
echo "# host: $(hostname)  $(pveversion)  $(zfs version | head -1)  kernel $(uname -r)"
echo "# date: $(date -u +%FT%TZ)  N=$N per command  loadavg: $(cut -d' ' -f1-3 /proc/loadavg)"
echo "# pools: $(zpool list -H -o name | tr '\n' ' ')  md arrays: $(grep -c '^md' /proc/mdstat)  disks: $(lsblk -dn -o TYPE | grep -c disk)"
DISK=/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT1
POOL=$(zpool list -H -o name | head -1)
MP=$(zfs get -H -o value mountpoint "$POOL")
t "zpool status -jv"                                            zpool status -jv
t "zpool list -j"                                               zpool list -j
t "zpool get all -j"                                            zpool get all -j
t "zpool get -H -o value guid -- <pool>"                        zpool get -H -o value guid -- "$POOL"
t "zfs list -H -p -t filesystem -o name,mountpoint,canmount,mounted" zfs list -H -p -t filesystem -o name,mountpoint,canmount,mounted
t "zfs get -j all -- <pool>"                                    zfs get -j all -- "$POOL"
t "zfs list -t snapshot -Hp -o name,createtxg -r"               zfs list -t snapshot -Hp -o name,createtxg -r
t "zpool import   (device scan, no args)"                       zpool import
t "zpool iostat -plv 1 2   (samples for 1 s by design)"         zpool iostat -plv 1 2
t "smartctl -n standby -iH --json <disk>   (QEMU disk)"         smartctl -n standby -iH --json "$DISK"
t "smartctl -a --json <disk>   (QEMU disk)"                     smartctl -a --json "$DISK"
t "lsblk -Jb -O"                                                lsblk -Jb -O
t "findmnt --json"                                              findmnt --json
t "cat /proc/mdstat"                                            cat /proc/mdstat
t "mdadm --detail --scan"                                       mdadm --detail --scan
t "pvs --reportformat json"                                     pvs --reportformat json
t "vgs --reportformat json"                                     vgs --reportformat json
t "lvs -a --reportformat json"                                  lvs -a --reportformat json
t "blkid"                                                       blkid
t "udevadm settle   (idle event queue)"                         udevadm settle
t "systemctl show anasd -p ActiveState"                         systemctl show anasd -p ActiveState
t "systemctl list-timers --all --output=json"                   systemctl list-timers --all --output=json
t "journalctl -u anasd -n 50 -o short-iso --no-pager"           journalctl -u anasd -n 50 -o short-iso --no-pager
t "smbstatus --json"                                            smbstatus --json
t "smbstatus -S"                                                smbstatus -S
t "testparm -s"                                                 testparm -s
t "pdbedit -L"                                                  pdbedit -L
t "exportfs -v   (list only)"                                   exportfs -v
t "getent passwd"                                               getent passwd
t "getent group"                                                getent group
t "getfacl -pcE <pool mountpoint>"                              getfacl -pcE "$MP"
t "ls /sys/kernel/config/target/iscsi"                          ls /sys/kernel/config/target/iscsi
t "timeout 2 stat -f /   (mount liveness)"                      timeout 2 stat -f /
