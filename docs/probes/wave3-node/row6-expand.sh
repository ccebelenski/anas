#!/usr/bin/env bash
# Wave-3 node pass, row 6 (cr.34's mdadm question): does `mdadm --grow` return
# at once, and does any mdadm monitor (grow-continue) sit in anasd's process
# group or cgroup while the array reshapes?
#
# AHR pool w3x (raid1×2 on hot7+hot8, ahr.sh create) expanded with hot9:
# raid1×2 → raid5×3 (`mdadm --grow --level=5 --raid-devices=3`, no backup file).
#   - every exec anasd makes, with its start/exit time: strace -f -tt on the
#     anasd main pid (execve + exit_group only), installed for the pass
#   - every 0.5 s: every mdadm process with pid/ppid/pgid/sid/systemd unit, the
#     md sync_action and /proc/mdstat's progress line
set -uo pipefail
source "$(dirname "$0")/lib.sh"
node "set -e; A=\$(systemctl show -p MainPID --value anasd); echo \"anasd main pid \$A\"; ps -o pid,pgid,sid,unit,cmd -p \$A
  rm -f /root/w3-expand.strace /root/w3-expand-ps.txt
  nohup strace -f -tt -qq -e trace=execve,exit_group -e signal=none -s 200 -o /root/w3-expand.strace -p \$A >/dev/null 2>&1 &
  echo \$! > /root/w3-strace.pid
  nohup bash -c 'end=\$(( \$(date +%s) + 600 )); while [ \$(date +%s) -lt \$end ] && [ ! -e /root/w3-stop ]; do
      { date -u +%T.%N | cut -c1-12; ps -eo pid,ppid,pgid,sid,unit:28,stat,etime,cmd | grep -E \"[m]dadm\" ; for a in /sys/block/md*/md/sync_action; do echo \"  \$a=\$(cat \$a)\"; done; grep -E \"reshape|recovery|resync\" /proc/mdstat; } >> /root/w3-expand-ps.txt 2>&1; sleep 0.5; done' >/dev/null 2>&1 &
  rm -f /root/w3-stop; sleep 1; echo tracing"
s=$(date +%s)
WAIT_S=900 "$HERE/ahr.sh" expand
echo "expand job took $(( $(date +%s) - s )) s (challenge → job end)"
node "touch /root/w3-stop; sleep 1; kill \$(cat /root/w3-strace.pid); sleep 1; rm -f /root/w3-stop /root/w3-strace.pid; cat /proc/mdstat | grep -A3 ^md; systemctl list-units --all 'mdadm-grow-continue*' --no-legend"
scp -q -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR root@192.168.200.50:/root/w3-expand.strace root@192.168.200.50:/root/w3-expand-ps.txt "$HERE/out/"
echo "--- mdadm execs (start and exit), from the strace:"
grep -nE 'execve\("/usr/sbin/mdadm' "$HERE/out/w3-expand.strace" | head -20
