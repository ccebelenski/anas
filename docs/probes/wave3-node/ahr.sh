#!/usr/bin/env bash
# Wave-3 node pass, rows 5 (cr.38 node facts) and 6 (cr.34 mdadm question).
#
# Disks: hot7 + hot8 (2 GiB) and hot9 (4 GiB) from test/stunt-node/ahrexpand-fixture.sh
# `up` (the fixture only attaches blank disks; it builds nothing), hot20
# (512 MB, blank) as the cache disk. The pool is `w3x`, built and destroyed
# through the API.
#
#   ahr.sh create | cache | vgs | locks-watch <seconds> | spare-add | spare-remove | expand | destroy
set -uo pipefail
source "$(dirname "$0")/lib.sh"
ID() { echo "scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT$1"; }
P=w3x
case "${1:-}" in
  create)
    s=$(date +%s)
    "$HERE/confirmed.sh" POST /ahr "{\"name\":\"$P\",\"tier\":\"ahr1\",\"disks\":[\"$(ID 7)\",\"$(ID 8)\"]}"
    echo "create took $(( $(date +%s) - s )) s"
    node "cat /proc/mdstat | grep -A2 ^md; vgs -o vg_name,vg_uuid $P; findmnt /mnt/anas-ahr/$P" ;;
  cache)
    say "row 5a: cache attach $(ID 20), detach, blkid -p"
    node "blkid -p /dev/disk/by-id/$(ID 20); echo \"blkid-exit=\$? (before attach, blank disk)\""
    r=$(api POST /ahr/$P/cache "{\"disks\":[\"$(ID 20)\"]}"); echo "$r"; wait_job "$(job_of "$r")" 120; echo "$LAST_JOB" | cut -c1-500
    node "lvs -a -o lv_name,lv_attr,devices $P"
    "$HERE/confirmed.sh" DELETE /ahr/$P/cache | tail -2 | cut -c1-500
    node "echo '--- blkid -p after detach:'; blkid -p /dev/disk/by-id/$(ID 20); echo \"blkid-exit=\$?\"; sgdisk -p /dev/disk/by-id/$(ID 20) | tail -4; lsblk -o NAME,SIZE,FSTYPE,PARTLABEL /dev/disk/by-id/$(ID 20)"
    say "row 5a: attach again onto the detached disk (PTTYPE-only must pass the signature gate)"
    r=$(api POST /ahr/$P/cache "{\"disks\":[\"$(ID 20)\"]}"); echo "$r"; j=$(job_of "$r" 2>/dev/null); [ -n "$j" ] && { wait_job "$j" 120; echo "$LAST_JOB" | cut -c1-400; }
    "$HERE/confirmed.sh" DELETE /ahr/$P/cache | tail -1 | cut -c1-300 ;;
  blkid-capture)  # the raw bytes for the fixture
    node "blkid -p /dev/disk/by-id/$(ID 20); echo \"exit=\$?\"" ;;
  vgs)
    node "vgs --reportformat json --units b --nosuffix -o +vg_uuid; echo \"exit=\$?\"" ;;
  locks-watch)  # poll the live lock table on the node every ~0.3 s for $2 seconds, print each distinct table
    node "end=\$(( \$(date +%s) + ${2:-20} )); last=''; while [ \$(date +%s) -lt \$end ]; do t=\$(node /root/w3-held-locks.mjs 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps([(h[\"key\"],h[\"mode\"],[x[\"operation\"] for x in h[\"holders\"]]) for h in d[\"held\"]]))'); if [ \"\$t\" != \"\$last\" ]; then echo \"\$(date -u +%T.%N | cut -c1-12) \$t\"; last=\$t; fi; sleep 0.2; done" ;;
  spare-add)
    s=$(date +%s.%N)
    "$HERE/confirmed.sh" POST /ahr/$P/spare "{\"diskId\":\"$(ID 9)\"}" | cut -c1-500
    python3 -c "import time; print('spare add (challenge → job end): %.1f s' % (time.time() - $s))" ;;
  spare-remove)
    "$HERE/confirmed.sh" DELETE /ahr/$P/spare/$(ID 9) | cut -c1-400 ;;
  expand)
    "$HERE/confirmed.sh" POST /ahr/$P/expand "{\"addDisks\":[\"$(ID 9)\"]}" | cut -c1-600 ;;
  destroy)
    "$HERE/confirmed.sh" DELETE /ahr/$P | tail -2 | cut -c1-400
    node "cat /proc/mdstat | grep ^md; vgs 2>&1 | tail -2; grep -c $P /etc/mdadm/mdadm.conf /etc/fstab" ;;
  *) echo "usage: see header"; exit 2 ;;
esac
