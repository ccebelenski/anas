#!/usr/bin/env bash
# Wave-3 node pass (docs/LIVE-PROOF-0.4.4-wave3.md): a tiny ANAS API client for
# the stunt node, through pveproxy → /anas → gateway → anasd exactly as the
# panels and the integration specs go. root@pam ticket + CSRF token from one
# /access/ticket reply (cr.25b's rule), cached for 90 minutes.
#
#   api.sh login
#   api.sh GET  /pools
#   api.sh POST /pools/x/export '{}'            [-H 'X-Anas-Confirm-Code: …']
#   api.sh DELETE '/pools/x?cleanup=false'      [-H 'X-Anas-Confirm-Code: …']
#   api.sh job <id>                              (one GET /jobs/<id>)
#   api.sh wait <id> [seconds]                   (poll until not queued/running; prints each change)
#
# Every call prints `HTTP <code> <time>s` on stderr, the response headers that
# matter (X-Anas-Confirm-Code) and the body on stdout.
set -euo pipefail
NODE=${NODE:-192.168.200.50}
BASE="https://${NODE}:8006/anas/api/nodes/anas-pve/v1"
STATE=${API_STATE:-${TMPDIR:-/tmp}/w3-api-session}
login() {
  local r
  r=$(curl -sk --max-time 15 -d 'username=root@pam' --data-urlencode 'password=anas-test' "https://${NODE}:8006/api2/json/access/ticket")
  python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print(d["ticket"]); print(d["CSRFPreventionToken"])' <<<"$r" > "$STATE"
}
session() {
  if [ ! -s "$STATE" ] || [ -n "$(find "$STATE" -mmin +90 2>/dev/null)" ]; then login; fi
  TICKET=$(sed -n 1p "$STATE"); CSRF=$(sed -n 2p "$STATE")
}
call() {
  local method=$1 path=$2; shift 2
  local body=""
  if [ $# -gt 0 ] && [ "${1:0:1}" != "-" ]; then body=$1; shift; fi
  session
  local hdr; hdr=$(mktemp)
  local args=(-sk --max-time "${MAXTIME:-60}" -X "$method" -D "$hdr" -o /dev/stdout -w '\n%{http_code} %{time_total}\n'
    -b "PVEAuthCookie=${TICKET}" -H "CSRFPreventionToken: ${CSRF}")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data "$body")
  local out; out=$(curl "${args[@]}" "$@" "${BASE}${path}")
  local status; status=$(tail -n1 <<<"$out")
  echo "HTTP $status" >&2
  grep -i '^x-anas-confirm-code' "$hdr" >&2 || true
  rm -f "$hdr"
  sed '$d' <<<"$out"
}
case "${1:-}" in
  login) login; echo "ok" ;;
  GET|POST|PUT|DELETE|PATCH) m=$1; shift; call "$m" "$@" ;;
  job) call GET "/jobs/$2" ;;
  wait)
    id=$2; limit=${3:-600}; start=$(date +%s); last=""
    while :; do
      j=$(call GET "/jobs/$id" 2>/dev/null)
      line=$(python3 -c 'import json,sys
d=json.load(sys.stdin); j=d.get("job",d)
print(j.get("status"), "|", j.get("progress") or "", "|", json.dumps(j.get("result")) if j.get("result") is not None else "", "|", json.dumps(j.get("error")) if j.get("error") else "")' <<<"$j" 2>/dev/null || echo "$j")
      if [ "$line" != "$last" ]; then echo "[t+$(( $(date +%s) - start ))s] $line"; last=$line; fi
      case "$line" in queued*|running*) ;; *) break ;; esac
      [ $(( $(date +%s) - start )) -ge "$limit" ] && { echo "wait: gave up after ${limit}s"; break; }
      sleep 0.5
    done ;;
  *) echo "usage: $0 login|GET|POST|PUT|DELETE path [json] [curl args]|job id|wait id [s]" >&2; exit 2 ;;
esac
