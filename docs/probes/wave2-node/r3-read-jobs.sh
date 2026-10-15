#!/usr/bin/env bash
# Row 3 (cr.48): the three slow interactive reads are read.* jobs, through /anas as root@pam
# exactly as the dialogs call them: 202, poll, the answer in job.result; Cancel = POST
# /v1/jobs/:id/cancel with no confirm, and the child's whole process group is gone.
#   fast  — each against a peer that answers (w2ok sftp; PBS pbsgt, read-only)
#   slow  — each against 192.0.2.10 (blackholed): the preview still running past 12 s, then
#           cancelled; the remote test and the catalog listing cancelled at t+3 s (their
#           own clients give up on a dead peer inside 12 s — see the first run's log)
#   r3-read-jobs.sh [preview] [test] [catalog]
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
A="$(dirname "$0")/a.sh"
post() { "$A" POST "$1" "$2" 2>&1; }
pgroups() { # the read job's children: pid, pgid, elapsed, command
  node "ps -eo pid,pgid,etimes,args | grep -E '[r]clone (copy|sync|lsjson|lsf)|[p]roxmox-backup-client|[t]imeout [0-9]+ /usr/bin/(rclone|proxmox)' | cut -c1-200"
}
slow_then_cancel() { # label path body [seconds before the cancel, default 15]
  local label=$1 path=$2 body=$3 wait=${4:-15}
  say "$label — slow: against 192.0.2.10"
  local out; out=$(post "$path" "$body"); echo "$out" | head -2
  local id; id=$(job_of "$out")
  local t0; t0=$(date +%s)
  sleep "$wait"
  echo "> at t+$(( $(date +%s) - t0 ))s:"
  "$A" job "$id" 2>/dev/null | python3 -c 'import json,sys; j=json.load(sys.stdin)["job"]; print("  job", j["operation"], j["status"], "| progress:", j.get("progress"))'
  local ps; ps=$(pgroups); echo "$ps" | sed 's/^/  ps: /'
  local pg; pg=$(awk 'NR==1{print $2}' <<<"$ps"); pg=${pg:-0}
  echo "> Cancel (POST /jobs/$id/cancel, no x-anas-confirm)"
  "$A" POST "/jobs/$id/cancel" 2>&1 | head -3 | sed 's/^/  /'
  "$A" wait "$id" 30 | tail -1 | sed 's/^/  /'
  sleep 1
  echo "> process group $pg after the cancel: $(node "ps -g $pg -o pid,args --no-headers" | wc -l) processes"
  echo "> any child left: $(pgroups | wc -l)"
  echo "  lasted $(( $(date +%s) - t0 ))s"
}
SECTIONS=" ${*:-preview test catalog} "

case $SECTIONS in *" preview "*)
say "preview — fast (w2ok → rclonegt@127.0.0.1)"
out=$(post /cloud/tasks/preview '{"source":"/gtbackup/w2src","remote":"w2ok","path":"w2dst","mode":"copy"}'); echo "$out" | head -2
"$A" wait "$(job_of "$out")" 120 | sed 's/^/  /'
slow_then_cancel "preview" /cloud/tasks/preview '{"source":"/gtbackup/w2src","remote":"w2bh","path":"w2dst","mode":"copy"}' 15
;; esac

case $SECTIONS in *" test "*)
say "remote test — fast (w2ok)"
out=$(post /cloud/remotes/test '{"name":"w2ok"}'); echo "$out" | head -2
"$A" wait "$(job_of "$out")" 120 | sed 's/^/  /'
slow_then_cancel "remote test" /cloud/remotes/test '{"name":"w2bh"}' 3
;; esac

case $SECTIONS in *" catalog "*)
say "catalog listing — fast (pbsgt on the PBS VM, read-only)"
g=$("$A" GET /backup/repos/pbsgt/groups 2>/dev/null)
grp=$(python3 -c 'import json,sys; gs=json.load(sys.stdin)["data"].get("groups") or []; print(gs[0]["group"] if gs else "")' <<<"$(json_of "$g")")
echo "groups: $(python3 -c 'import json,sys; print([g["group"] for g in json.load(sys.stdin)["data"].get("groups") or []])' <<<"$(json_of "$g")")"
s=$("$A" GET "/backup/repos/pbsgt/groups?group=$grp" 2>/dev/null)
read -r snap arch < <(python3 -c 'import json,sys
d=json.load(sys.stdin)["data"]; s=(d.get("snapshots") or [])[-1]
a=next((f.get("archive") for f in (s.get("files") or []) if isinstance(f,dict) and f.get("archive")), "")
print(s["snapshot"], a)' <<<"$(json_of "$s")")
echo "snapshot: $snap  archive: $arch"
out=$(post /backup/restore/browse "{\"repo\":\"pbsgt\",\"snapshot\":\"$snap\",\"archive\":\"$arch\",\"path\":\"/\"}"); echo "$out" | head -2
"$A" wait "$(job_of "$out")" 120 | cut -c1-700 | sed 's/^/  /'
slow_then_cancel "catalog listing" /backup/restore/browse "{\"repo\":\"w2bh\",\"snapshot\":\"host/w2b1/2026-10-15T00:00:00Z\",\"archive\":\"w2data.pxar\",\"path\":\"/\"}" 3
;; esac
