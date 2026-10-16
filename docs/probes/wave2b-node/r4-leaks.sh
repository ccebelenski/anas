#!/usr/bin/env bash
# Row 4: remove what failed specs leaked, through the API doors (run 1 left the snapshot schedule
# `pvepool-proof` — pvepool-api test 9 failed before its own delete — and the cloud remote
# `gtcancelsftp` in /etc/anas/rclone.conf — cloud-cancel's teardown assertion failed first).
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
say "schedules"; r=$(api GET /schedules); grep -o '"id":"[^"]*"' <<<"$r" | sort -u
for id in $(grep -o '"id":"pvepool-proof[^"]*"' <<<"$r" | cut -d'"' -f4 | sort -u); do
  r2=$(api DELETE /schedules/$id); echo "$r2" | head -2; j=$(job_of "$r2"); [ -n "$j" ] && wait_job "$j" 60 | tail -1
done
say "cloud remotes"
for rm in $(api GET /cloud/remotes | grep -o '"name":"gt[a-z0-9-]*"' | cut -d'"' -f4 | sort -u); do
  confirmed DELETE /cloud/remotes/$rm | head -4; [ -n "${CONFIRMED_JOB:-}" ] && wait_job "$CONFIRMED_JOB" 60 | tail -1
done
say "node"; node 'wc -c </etc/anas/rclone.conf; ls /etc/systemd/system | grep -E "anas-(snap|cloud|backup|repl)-" || echo "no task/schedule units"'
