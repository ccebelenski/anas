#!/usr/bin/env bash
# Wave-3 node pass, N1 as the design wrote it: does a REPLICATION run hold a
# shared claim on its source? A local task w3dm/a → w3dm/rep, run while the
# pool's device is suspended (so the run sits inside its first `zfs` command),
# and the daemon's live lock table read through the inspector (held-locks.mjs,
# copied to the node as /root/w3-held-locks.mjs; anasd's inspector already open).
set -uo pipefail
source "$(dirname "$0")/lib.sh"
say "task w3rep (disabled, far-future schedule)"
r=$(api POST /replication/tasks '{"name":"w3rep","source":{"pool":"w3dm","dataset":"a"},"target":{"pool":"w3dm","dataset":"rep"},"schedule":"2030-01-01 00:00:00","enabled":false}'); echo "$r"; wait_job "$(job_of "$r")" 60
node "dmsetup suspend w3dm && dmsetup info w3dm | grep State"
say "Run now, device suspended"
r=$(api POST /replication/tasks/w3rep/run '{}'); echo "$r"
sleep 4
api GET '/jobs?status=running' | tail -1 | python3 -c 'import json,sys; [print(" ", j["id"], j["operation"], j["status"], j.get("progress")) for j in json.load(sys.stdin)["data"]]'
node "node /root/w3-held-locks.mjs; ps -eo pid,stat,wchan:22,cmd | grep -E '[z]fs (snapshot|send|recv)' | head"
say "a pool destroy now: does it wait?"
r=$(api DELETE "/pools/w3dm?cleanup=false"); echo "$r" | head -2; c=$(code_of "$r")
echo "(not confirmed — the code is not resent; the question is answered by the lock table above)"
node "dmsetup resume w3dm && dmsetup info w3dm | grep State"
sleep 8
api GET '/jobs' | tail -1 | python3 -c 'import json,sys; [print(" ", j["id"], j["operation"], j["status"], (j.get("error") or {}).get("message","")[:160]) for j in json.load(sys.stdin)["data"][-4:]]'
node "zfs list -t all -o name -r w3dm"
