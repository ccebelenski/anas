#!/usr/bin/env bash
# Row 17 setup: before the upgrade, make every pveproxy worker serve /anas so each has
# require'd the OLD AnasProxy.pm (workers keep a loaded module — F12). Then the upgrade
# install must make them load the new one without a manual restart.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
"$API" login >/dev/null
echo "# ${N:-12} GETs /pools through :8006/anas"
for i in $(seq "${N:-12}"); do "$API" GET /pools 2>&1 >/dev/null | grep -o '^HTTP.*'; done | sort | uniq -c
node 'journalctl -u pveproxy --since "-2min" --no-pager -o short-iso | grep -i anas | tail -5; echo "workers:"; pgrep -f "^pveproxy worker" | tr "\n" " "; echo'
