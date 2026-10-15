#!/usr/bin/env bash
# Shared helpers for the wave-3 node-pass probes (docs/LIVE-PROOF-0.4.4-wave3.md).
# Sourced, never run. `api` = docs/probes/wave3-node/api.sh; `node` = ssh to the stunt node.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API="$HERE/api.sh"
export API_STATE=${API_STATE:-${TMPDIR:-/tmp}/w3-api-session}
node() { ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o LogLevel=ERROR root@192.168.200.50 "$@"; }
say() { printf '\n### %s\n' "$*"; }
# api METHOD PATH [JSON] [curl args…] → body on stdout; "HTTP <code> <s>" + confirm header on stderr (kept in the log)
api() { "$API" "$@" 2>&1; }
# Last call's pieces, from a captured `api` output
http_of() { sed -n 's/^HTTP \([0-9]*\).*/\1/p' <<<"$1" | head -1; }
code_of() { sed -n 's/^[Xx]-[Aa]nas-[Cc]onfirm-[Cc]ode: *\([^[:space:]]*\).*/\1/p' <<<"$1" | head -1; }
json_of() { grep -E '^\{' <<<"$1" | head -1; }
jq_() { python3 -c 'import json,sys
d=json.loads(sys.argv[1]); e=sys.argv[2]
for k in e.split("."):
    d = d[int(k)] if isinstance(d,list) else (d or {}).get(k)
print(json.dumps(d) if isinstance(d,(dict,list)) else ("" if d is None else d))' "$1" "$2"; }
job_of() { jq_ "$(json_of "$1")" job.id; }
# wait_job ID [seconds] — prints status changes, returns the final job JSON in $LAST_JOB
wait_job() { "$API" wait "$1" "${2:-300}" 2>&1; LAST_JOB=$("$API" job "$1" 2>/dev/null); }
# confirmed METHOD PATH [JSON] — challenge, print the 409, resend with the code, print the 202
confirmed() {
  local m=$1 p=$2 b=${3:-}
  local r1; r1=$(api "$m" "$p" ${b:+"$b"}); echo "$r1"
  local c; c=$(code_of "$r1")
  if [ -z "$c" ]; then CONFIRMED_JOB=$(job_of "$r1" 2>/dev/null || true); return; fi
  local r2; r2=$(api "$m" "$p" ${b:+"$b"} -H "x-anas-confirm: $c"); echo "$r2"
  CONFIRMED_JOB=$(job_of "$r2" 2>/dev/null || true)
}
