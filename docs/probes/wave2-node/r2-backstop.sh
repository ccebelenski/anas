#!/usr/bin/env bash
# Row 2 (cr.28, jobs/authority.ts): the daemon's backstop over its unix socket directly,
# and the work no request started.
#   A  POST scrub with x-anas-privileges: Sys.Audit → 403 FORBIDDEN, the reason logged;
#      both privileges → 202; no header → 403 (fail closed)
#   B  a read.* job (the cloud preview) with Sys.Audit only over the socket → 202, and its
#      cancel with Sys.Audit → accepted; the same POST through /anas as anas-audit → the
#      gateway's 403 (it asks Sys.Modify for every POST)
#   C  the snapshot schedule's unit fired by hand (what its timer does) → its job runs
#   D  the udev cache-event script's exact header set on a job-submitting POST → 202; the
#      script itself against a pool that does not exist → delivered, 404 before any submit
# (The backup Run-Now half of "work no request started" is row 4's runs.)
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
A="$(dirname "$0")/a.sh"
mark() { MARK=$(node 'date +"%Y-%m-%d %H:%M:%S"'); }
sock() { # METHOD PATH PRIVS [BODY] — over the daemon's socket, as root on the node
  local body=${4:-}
  node "curl -s --max-time 20 -w '\nHTTP %{http_code}\n' -X $1 --unix-socket /run/anas/anasd.sock \
    -H 'x-anas-user: w2probe@pve' -H 'x-anas-user-uid: 0' -H \"x-anas-request-id: \$(cat /proc/sys/kernel/random/uuid)\" \
    ${3:+-H 'x-anas-privileges: $3'} ${body:+-H 'content-type: application/json' --data '$body'} http://localhost$2" | sed 's/^/  /'
}
anasd_journal() { node "journalctl -u anasd --since '$MARK' --no-pager -o cat | grep -aiE 'forbid|refus|privilege' | cut -c1-400 | sed 's/^/    anasd| /'"; }

say "A — POST /v1/pools/gtbackup/scrub over the socket"; mark
echo "> privileges: Sys.Audit";            sock POST /v1/pools/gtbackup/scrub 'Sys.Audit'
echo "> privileges: Sys.Audit,Sys.Modify"; out=$(sock POST /v1/pools/gtbackup/scrub 'Sys.Audit,Sys.Modify'); echo "$out"
echo "> no x-anas-privileges header";      sock POST /v1/pools/gtbackup/scrub ''
echo "> privileges: Sys.Modify (only)";    sock POST /v1/pools/gtbackup/scrub 'Sys.Modify'
anasd_journal

say "B — a read.* job (cloud preview, w2ok → rclonegt@127.0.0.1) with Sys.Audit only"; mark
PREV='{"source":"/gtbackup/w2src","remote":"w2ok","path":"w2dst","mode":"copy"}'
out=$(sock POST /v1/cloud/tasks/preview 'Sys.Audit' "$PREV"); echo "$out"
id=$(grep -o '"id":"[^"]*"' <<<"$out" | head -1 | cut -d'"' -f4)
node "sleep 4; curl -s --unix-socket /run/anas/anasd.sock -H 'x-anas-privileges: Sys.Audit' http://localhost/v1/jobs/$id | cut -c1-600" | sed 's/^/  job: /'
echo "> the same preview over the socket, slow remote (w2bh, blackholed), then its cancel with Sys.Audit only"
out=$(sock POST /v1/cloud/tasks/preview 'Sys.Audit' '{"source":"/gtbackup/w2src","remote":"w2bh","path":"w2dst","mode":"copy"}'); echo "$out"
id=$(grep -o '"id":"[^"]*"' <<<"$out" | head -1 | cut -d'"' -f4)
node 'sleep 3; pgrep -af "rclone " | cut -c1-200' | sed 's/^/  ps: /'
sock POST /v1/jobs/$id/cancel 'Sys.Audit'
node "sleep 3; curl -s --unix-socket /run/anas/anasd.sock -H 'x-anas-privileges: Sys.Audit' http://localhost/v1/jobs/$id | cut -c1-500; echo; pgrep -af 'rclone ' || echo '(no rclone process)'" | sed 's/^/  /'
echo "> a NON-read job's cancel with Sys.Audit only (a running scrub's job id)"
sid=$(grep -o '"id":"[^"]*"' <<<"$(sock POST /v1/pools/gtbackup/scrub 'Sys.Audit,Sys.Modify')" | head -1 | cut -d'"' -f4)
sock POST /v1/jobs/$sid/cancel 'Sys.Audit'
echo "> through /anas as anas-audit@pve (PVEAuditor): the same preview POST"
T=$(curl -sk -d username=anas-audit@pve --data-urlencode password=anas-w2-pw https://192.168.200.50:8006/api2/json/access/ticket)
TK=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["ticket"])' <<<"$T"); CS=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["CSRFPreventionToken"])' <<<"$T")
curl -sk -w '\n  HTTP %{http_code}\n' -b "PVEAuthCookie=$TK" -H "CSRFPreventionToken: $CS" -H 'content-type: application/json' --data "$PREV" \
  https://192.168.200.50:8006/anas/api/nodes/anas-pve/v1/cloud/tasks/preview | sed 's/^/  /'
anasd_journal
node "journalctl -u anas --since '$MARK' --no-pager -o cat | grep -a authz | cut -c1-300 | sed 's/^/    anas| /'"

say "C — the snapshot schedule w2snap: fire its unit (what the timer does)"; mark
node 'systemctl cat anas-snap-w2snap.timer | grep -E "OnCalendar|Unit"; systemctl cat anas-snap-w2snap.service | grep -E "ExecStart"
      systemctl start anas-snap-w2snap.service; echo "exit $?"; systemctl show -p Result,ExecMainStatus anas-snap-w2snap.service
      journalctl -u anas-snap-w2snap.service --since "'"$MARK"'" --no-pager -o cat | tail -6
      zfs list -H -o name -t snapshot -r gtbackup/w2src'
"$A" GET /jobs 2>/dev/null | python3 -c 'import json,sys
d=json.load(sys.stdin); jobs=d.get("data",d.get("jobs",d))
for j in (jobs if isinstance(jobs,list) else []):
    if "snapshot" in j.get("operation","") or "schedule" in j.get("operation",""):
        print("  job:", j["operation"], j["status"], j.get("createdBy"), j.get("createdAt"), (j.get("error") or {}).get("message",""))' | head -5
anasd_journal

say "D — the udev cache-event script's identity"; mark
echo "> its exact headers (x-anas-user: system:udev-cache-event, Sys.Audit,Sys.Modify) on POST /v1/pools/gtbackup/scrub"
node "curl -s -w '\nHTTP %{http_code}\n' --unix-socket /run/anas/anasd.sock -X POST -H 'x-anas-user: system:udev-cache-event' -H 'x-anas-user-uid: 0' \
  -H \"x-anas-request-id: \$(cat /proc/sys/kernel/random/uuid)\" -H 'x-anas-privileges: Sys.Audit,Sys.Modify' http://localhost/v1/pools/gtbackup/scrub" | sed 's/^/  /'
echo "> /usr/local/bin/anas-cache-event w2nopool-cache0 sdz (the installed script), and the same request it sends, with its answer shown"
node "/usr/local/bin/anas-cache-event w2nopool-cache0 sdz; echo \"script exit \$?\"
      journalctl -t anas-ahr --since '$MARK' --no-pager -o cat
      curl -s -w '\nHTTP %{http_code}\n' --unix-socket /run/anas/anasd.sock -H 'content-type: application/json' -H 'x-anas-user: system:udev-cache-event' \
        -H 'x-anas-user-uid: 0' -H \"x-anas-request-id: \$(cat /proc/sys/kernel/random/uuid)\" -H 'x-anas-privileges: Sys.Audit,Sys.Modify' \
        --data '{\"event\":\"device-removed\",\"slice\":\"w2nopool-cache0\",\"kernel\":\"sdz\"}' http://localhost/v1/ahr/w2nopool/cache/event" | sed 's/^/  /'
anasd_journal
