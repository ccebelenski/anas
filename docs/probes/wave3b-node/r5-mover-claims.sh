#!/usr/bin/env bash
# Wave-3b row 5 (cr.33b): a replication run holds shared claims on its source.
# Source pool w3r5s on a sparse FILE vdev, dataset w3r5s/src (API) with
# snapshots s0, s1 (API). Destination pool w3r5d on a dm-linear over a loop
# over /var/tmp/w3r/w3r5d.img: `dmsetup suspend w3r5d` makes the receive sleep in
# the kernel, so the run lasts exactly as long as the suspension (>= 30 s).
# Local task w3r5rep (disabled, far-future schedule), Run now.
# While the run lasts: a snapshot RENAME (s1 -> s1r) and a forced ROLLBACK to s0
# of the source are confirmed and queue behind it.
#
#   r5-mover-claims.sh setup | run | teardown
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
progress() { "$API" job "$1" 2>/dev/null | python3 -c 'import json,sys; j=json.load(sys.stdin)["job"]; print(" ", j["operation"], j["status"], "|", j.get("progress") or "", "|", (j.get("error") or {}).get("code",""), (j.get("error") or {}).get("message","")[:400], "|", json.dumps(j.get("result")) if j.get("result") else "")'; }
case "${1:-}" in
  setup)
    node "mkdir -p /var/tmp/w3r && truncate -s 1G /var/tmp/w3r/w3r5s.img /var/tmp/w3r/w3r5d.img && zpool create -O mountpoint=/w3r5s w3r5s /var/tmp/w3r/w3r5s.img && L=\$(losetup --find --show /var/tmp/w3r/w3r5d.img) && dmsetup create w3r5d --table \"0 \$(blockdev --getsz \$L) linear \$L 0\" && zpool create -o failmode=wait -O mountpoint=/w3r5d w3r5d /dev/mapper/w3r5d && zpool list -H -o name,health w3r5s w3r5d; losetup -a | grep w3r"
    r=$(api POST /pools/w3r5s/datasets '{"path":"src"}'); echo "$r"; wait_job "$(job_of "$r")" 60
    node "head -c 200M /dev/urandom > /w3r5s/src/blob && sync && ls -l /w3r5s/src"
    for s in s0 s1; do r=$(api POST /pools/w3r5s/datasets/src/snapshots "{\"name\":\"$s\"}"); echo "$r"; wait_job "$(job_of "$r")" 60; done
    r=$(api POST /replication/tasks '{"name":"w3r5rep","source":{"pool":"w3r5s","dataset":"src"},"target":{"pool":"w3r5d","dataset":"rep"},"schedule":"2030-01-01 00:00:00","enabled":false}'); echo "$r"; wait_job "$(job_of "$r")" 60
    node "zfs list -t all -o name -r w3r5s w3r5d" ;;
  run)
    say "suspend the destination's device; Run now"
    node "dmsetup suspend w3r5d && dmsetup info w3r5d | grep State; date -u +%T.%N | cut -c1-12"
    T0=$(date +%s)
    api POST /replication/tasks/w3r5rep/run '{}'
    sleep 4
    say "the running jobs"
    api GET '/jobs?status=running' | tail -1 | python3 -c 'import json,sys; [print(" ", j["id"], j["operation"], j["status"], j.get("progress")) for j in json.load(sys.stdin)["data"]]'
    R=$("$API" GET '/jobs?status=running' 2>/dev/null | python3 -c 'import json,sys; print(next(j["id"] for j in json.load(sys.stdin)["data"] if j["operation"]=="zfs.replicate"))')
    echo "  replication job: $R"
    node "ps -eo pid,stat,wchan:22,etime,cmd | grep -E '[z]fs (snapshot|send|recv|receive)' | head; zfs list -t snapshot -o name -r w3r5s"
    say "queue 1: rename snapshot s1 -> s1r of the source (challenge, resend)"
    confirmed PUT /pools/w3r5s/datasets/src/snapshots/s1 '{"newName":"s1r"}'
    RN=$CONFIRMED_JOB
    say "queue 2: rollback of the source to s0 with force (challenge, resend)"
    confirmed POST '/pools/w3r5s/datasets/src/snapshots/s0/rollback?force=true'
    RB=$CONFIRMED_JOB
    echo "rename=$RN rollback=$RB replication=$R" > "$(dirname "$0")/out/r5-ids.txt"
    say "while the run lasts (every 10 s)"
    for i in 1 2 3 4; do sleep 10; echo "--- t+$(( $(date +%s) - T0 ))s"; progress "$R"; [ -n "$RN" ] && progress "$RN"; [ -n "$RB" ] && progress "$RB"; done
    say "resume the destination at t+$(( $(date +%s) - T0 ))s"
    node "dmsetup resume w3r5d && dmsetup info w3r5d | grep State; date -u +%T"
    wait_job "$R" 180
    [ -n "$RN" ] && wait_job "$RN" 120
    [ -n "$RB" ] && wait_job "$RB" 120
    say "final"
    progress "$R"; [ -n "$RN" ] && progress "$RN"; [ -n "$RB" ] && progress "$RB"
    node "zfs list -t all -o name,creation -r w3r5s w3r5d" ;;
  teardown)
    node "dmsetup resume w3r5d 2>/dev/null; true"
    WAIT_S=60 "$(dirname "$0")/../wave3-node/confirmed.sh" DELETE /replication/tasks/w3r5rep
    node "zpool destroy w3r5s; zpool destroy w3r5d; dmsetup remove w3r5d; L=\$(losetup -a | grep w3r5d.img | cut -d: -f1); [ -n \"\$L\" ] && losetup -d \$L; rm -f /var/tmp/w3r/w3r5s.img /var/tmp/w3r/w3r5d.img; rmdir /w3r5s /w3r5d 2>/dev/null; zpool list -H -o name | grep -c w3r; dmsetup ls; losetup -a" ;;
  *) echo "usage: see header"; exit 2 ;;
esac
