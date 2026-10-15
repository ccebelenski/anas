#!/usr/bin/env bash
# Row 17 (WAVE2-DESIGN §8): what pveproxy is running before/after an install —
# master pid, worker pids and start times, which AnasProxy.pm each worker has loaded
# (the module path in its %INC is not visible from outside, so: the installed module's
# hash + mtime, and the workers' start times against it), the hook module's hash.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
node 'date -u +"now %FT%TZ (%s)"
systemctl show -p MainPID,ActiveEnterTimestamp,ExecMainStartTimestamp pveproxy
echo "--- workers (pid, start time)"; for p in $(pgrep -f "^pveproxy worker"); do echo "$p $(ps -o lstart= -p $p)"; done
echo "--- installed module"; ls -l --time-style=+%FT%T /usr/share/anas/perl/AnasProxy.pm 2>&1; sha256sum /usr/share/anas/perl/AnasProxy.pm 2>&1 | cut -c1-16
echo "--- hook in AnyEvent.pm"; grep -c AnasProxy /usr/share/perl5/PVE/APIServer/AnyEvent.pm
echo "--- proxy.key"; ls -l --time-style=+%FT%T /run/anas/proxy.key 2>&1
echo "--- pveproxy journal (last 15 min, reload/restart/anas lines)"; journalctl -u pveproxy --since "-15min" --no-pager -o short-iso | grep -Ei "reload|start|stop|anas" | tail -20'
