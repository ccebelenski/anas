#!/usr/bin/env bash
# Wave-3 node pass, N1 (WAVE3-DESIGN §8.3) + the abandoned-child half of N4.
#
# The design's N1 holds the pool behind a REPLICATION run (an S claim on the
# source). Shipped code gives replication, backup and cloud runs NO lock
# claims (routes/replication.ts submits `{ lane: 'long' }` only), so a
# replication cannot hold a destroy back. The holder here is a guarded
# `zfs.snapshot` job (zfsClaims: `zpool:<guid>` SHARED) on the pool `w3dm`
# (n4.sh) whose device is SUSPENDED, so its `zfs snapshot` sleeps in the
# kernel until `dmsetup resume` — a holder of exactly controlled length.
#
#   1. suspend; POST snapshot w3dm/a@hold → the job runs and blocks
#   2. DELETE /pools/w3dm challenged + confirmed → the destroy job QUEUES
#      behind the snapshot (zpool:<guid> X vs S), its progress names it
#   3. a LUN on the zvol w3dm/vol is created BY HAND (targetcli)
#   4. the snapshot's command passes its 300 s job deadline: TERM → 5 s → KILL
#      → 2 s; a child that cannot die is ABANDONED (GET /v1/health lists it)
#      and its job keeps its locks (`holdsLocks`) — the destroy keeps waiting
#   5. resume → the child exits, the registry empties, the locks go, the
#      destroy runs ITS gates → the LUN refusal; the pool is intact
#
#   n1.sh prep | run | lun-down
set -uo pipefail
source "$(dirname "$0")/lib.sh"
IQN=iqn.2003-01.org.linux-iscsi.anas-pve:w3n1
snap() { api GET /health; node "dmsetup info w3dm | grep State; zpool list -H -o name,health w3dm; ps -eo pid,stat,wchan:22,etime,cmd | awk '\$2 ~ /D/' | grep -v -E 'jbd2|udev-worker|txg_sync' | head -5"; }
case "${1:-}" in
  prep)
    node "zfs create -V 64M w3dm/vol && udevadm settle && ls -l /dev/zvol/w3dm/vol; dmsetup info w3dm | grep State" ;;
  run)
    say "1. suspend; snapshot job (the holder)"
    node "dmsetup suspend w3dm && dmsetup info w3dm | grep State; date -u +%T"
    r=$(api POST /pools/w3dm/datasets/a/snapshots '{"name":"hold"}'); echo "$r"; H=$(job_of "$r")
    sleep 2; api job "$H"
    say "2. pool destroy, challenged + confirmed"
    r=$(api DELETE "/pools/w3dm?cleanup=false"); echo "$r"; c=$(code_of "$r")
    r=$(api DELETE "/pools/w3dm?cleanup=false" -H "x-anas-confirm: $c"); echo "$r"; D=$(job_of "$r")
    sleep 2; api job "$D"
    echo "holder=$H destroy=$D" > "$HERE/out/n1-ids.txt"
    say "3. a LUN on w3dm/vol, by hand"
    node "targetcli /backstores/block create name=w3lun dev=/dev/zvol/w3dm/vol && targetcli /iscsi create $IQN && targetcli /iscsi/$IQN/tpg1/luns create /backstores/block/w3lun && targetcli saveconfig >/dev/null && targetcli ls /iscsi/$IQN/tpg1/luns 2>&1 | tail -2; date -u +%T"
    say "4. waiting out the holder's 300 s job deadline (+ the 7 s kill ladder)"
    for i in $(seq 1 14); do sleep 25; echo "--- t+$((i*25))s $(date -u +%T)"; api job "$H" | tail -1 | cut -c1-400; api job "$D" | tail -1 | cut -c1-400; done
    say "4b. after the deadline"
    snap
    api GET /status | tail -1 | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print(json.dumps([w for w in d.get("warnings",[]) if w.get("category") in ("command","job","jobs")], indent=1))'
    say "5. resume"
    node "dmsetup resume w3dm && dmsetup info w3dm | grep State; date -u +%T"
    sleep 6
    wait_job "$H" 60; echo "$LAST_JOB"
    wait_job "$D" 120; echo "$LAST_JOB"
    snap
    node "zfs list -t all -o name -r w3dm; targetcli ls /backstores/block 2>&1 | grep w3lun" ;;
  lun-down)
    node "targetcli /iscsi delete $IQN; targetcli /backstores/block delete w3lun; targetcli saveconfig >/dev/null; targetcli ls / 2>&1 | head -12" ;;
  *) echo "usage: $0 prep|run|lun-down"; exit 2 ;;
esac
