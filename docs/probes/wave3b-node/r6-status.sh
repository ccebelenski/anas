#!/usr/bin/env bash
# Wave-3b row 6 (cr.35r): GET /v1/status through the gateway answers with every
# section, `unavailable: []`, three times; and the same on the daemon's socket.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
for i in 1 2 3; do
  s=$(date +%s%N); out=$("$API" GET /status 2>&1); ms=$(( ($(date +%s%N) - s) / 1000000 ))
  echo "--- run $i: $(http_of "$out") in ${ms} ms"
  json_of "$out" | python3 -c '
import json,sys
d=json.load(sys.stdin)["data"]
print("  keys:", sorted(d.keys()))
print("  unavailable:", d.get("unavailable"))
print("  pools:", [(p.get("name"), p.get("state") or p.get("health") or p.get("status")) for p in d["pools"]]); print("  pool brief keys:", sorted(d["pools"][0].keys()) if d["pools"] else None)
print("  disks:", json.dumps(d["disks"]))
print("  shares:", json.dumps(d["shares"])[:200])
print("  jobs:", len(d["jobs"]), " ahrPools:", len(d["ahrPools"]))
print("  warnings:", len(d["warnings"]), sorted({w.get("category") for w in d["warnings"]}))
for w in d["warnings"]: print("    -", w.get("severity"), w.get("category"), (w.get("message") or "")[:200])
'
done
say "the daemon's socket, directly"
node "curl -s -w '\n%{http_code} %{time_total}\n' --unix-socket /run/anas/anasd.sock http://localhost/v1/status | tail -1; curl -s --unix-socket /run/anas/anasd.sock http://localhost/v1/status | python3 -c 'import json,sys; d=json.load(sys.stdin)[\"data\"]; print(\"  unavailable:\", d.get(\"unavailable\"))'"
