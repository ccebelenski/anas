#!/usr/bin/env bash
# Row 4 (cr.49): three backup Run-Nows at once (tasks w2b1..w2b3 on repo w2bh → 192.0.2.10,
# blackholed, so each direct run sits in proxmox-backup-client's connect for ~10 s). The
# queue has concurrency 4 and 3 long slots; before cr.49 the three supervisors took the
# three long slots and their direct runs waited. Shown: every job's createdAt/startedAt
# (GET /jobs carries no params: the supervisors are the three ids the Run-Now doors
# answered; the other three are the direct runs the units submitted over the socket), the
# three pbc processes alive at once, the audit lines.
# Also (row 2, cr.28): a running direct run's cancel over the socket with Sys.Audit only.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
A="$(dirname "$0")/a.sh"
SINCE=$(node 'date -u +%Y-%m-%dT%H:%M:%S'); JSINCE=$(node 'date "+%Y-%m-%d %H:%M:%S"')
table() { # the backup.task.run jobs created since $SINCE; S = supervisor ids
  "$A" GET /jobs 2>/dev/null | S="$SUP" T="$SINCE" python3 -c 'import json,sys,os
sup=os.environ["S"].split(); out=[]
for j in json.load(sys.stdin)["data"]:
    if j["operation"]=="backup.task.run" and j["createdAt"][:19]>=os.environ["T"]:
        out.append(j)
for j in sorted(out, key=lambda j: j["createdAt"]):
    kind="supervisor" if j["id"] in sup else "direct"
    print("  %s %-10s %-9s created %s started %s ended %s | %s | %s" % (j["id"][:8], kind, j["status"], j["createdAt"][11:23], (j.get("startedAt") or "-")[11:23], (j.get("completedAt") or "-")[11:23], (j.get("progress") or "")[:60], ((j.get("error") or {}).get("message") or "")[:60]))'
}
say "three Run-Nows, back to back"
SUP=""
for t in w2b1 w2b2 w2b3; do
  r=$("$A" POST /backup/tasks/$t/run '{}' 2>&1); echo "$r" | head -2 | sed "s/^/  $t: /"; SUP="$SUP $(job_of "$r")"
done
sleep 3
say "t+3 s: the jobs and the processes"
table
node 'ps -eo pid,etimes,args | grep "[p]roxmox-backup-client backup" | cut -c1-150'
did=$("$A" GET /jobs 2>/dev/null | S="$SUP" T="$SINCE" python3 -c 'import json,sys,os
sup=os.environ["S"].split()
for j in json.load(sys.stdin)["data"]:
    if j["operation"]=="backup.task.run" and j["createdAt"][:19]>=os.environ["T"] and j["id"] not in sup and j["status"]=="running":
        print(j["id"]); break')
say "row 2 extra: cancel the running direct run ${did:0:8} over the socket with Sys.Audit only"
node "curl -s -w '\nHTTP %{http_code}\n' --unix-socket /run/anas/anasd.sock -X POST -H 'x-anas-user: w2probe@pve' -H 'x-anas-user-uid: 0' \
  -H \"x-anas-request-id: \$(cat /proc/sys/kernel/random/uuid)\" -H 'x-anas-privileges: Sys.Audit' http://localhost/v1/jobs/$did/cancel" | sed 's/^/  /'
say "wait for all six to end"
for i in $(seq 40); do
  n=$("$A" GET /jobs 2>/dev/null | T="$SINCE" python3 -c 'import json,sys,os
print(sum(1 for j in json.load(sys.stdin)["data"] if j["operation"]=="backup.task.run" and j["createdAt"][:19]>=os.environ["T"] and j["status"] in ("queued","running")))')
  [ "$n" = 0 ] && break; sleep 2
done
table
say "audit lines (job.submitted / job.refused) for these runs"
node "journalctl -u anasd --since '$JSINCE' --no-pager -o cat | grep -a '\"audit\":true' | grep -aE 'backup.task.run|job.cancel' | grep -aE 'job.submitted|job.refused|job.started' \
  | python3 -c 'import json,sys
for l in sys.stdin:
    try: d=json.loads(l)
    except Exception: continue
    print(\"  \", d.get(\"time\"), d.get(\"event\"), d.get(\"user\"), d.get(\"operation\"), json.dumps(d.get(\"params\")), d.get(\"lane\",\"\"), d.get(\"reason\",\"\"))'"
node "journalctl --since '$JSINCE' --no-pager -o cat | grep -aiE 'notif' | grep -a w2b | cut -c1-200 | head -6"
