#!/usr/bin/env bash
# Wave-3 node pass, N4's ladder half (cr.35): when the DAEMON does not answer at
# all, who answers the browser, and when? anasd's main process is frozen with
# SIGSTOP (nothing it runs is touched; SIGCONT resumes it), then GET /pools
# goes through pveproxy → AnasProxy (30 s) → the gateway's socket proxy (20 s)
# → the frozen anasd. Expected: the gateway's 504 GATEWAY_TIMEOUT in the ANAS
# envelope at ~20 s, never AnasProxy's synthetic 502 at 30 s.
set -uo pipefail
source "$(dirname "$0")/lib.sh"
node "A=\$(systemctl show -p MainPID --value anasd); kill -STOP \$A; echo \"anasd \$A stopped (SIGSTOP) at \$(date -u +%T.%N | cut -c1-12)\""
s=$(date +%s%N)
out=$(MAXTIME=45 "$API" GET /pools 2>&1)
echo "GET /pools -> $(http_of "$out") after $(( ($(date +%s%N) - s) / 1000000 )) ms"
json_of "$out"
s=$(date +%s%N)
out=$(MAXTIME=45 "$API" GET /status 2>&1)
echo "GET /status -> $(http_of "$out") after $(( ($(date +%s%N) - s) / 1000000 )) ms"
json_of "$out"
node "A=\$(systemctl show -p MainPID --value anasd); kill -CONT \$A; echo \"anasd \$A continued at \$(date -u +%T.%N | cut -c1-12)\"; sleep 2; systemctl is-active anasd anas; systemctl show -p NRestarts anasd"
"$API" GET /health
