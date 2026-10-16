#!/usr/bin/env bash
# Row 2 (cr.41b), through ANAS: the backup-task delete door over the units setup.sh made.
#   A  w2bt2's .service made one systemd cannot load (its ExecStart= line removed → LoadState
#      bad-setting, "Service has no ExecStart=… Refusing."), X-ANAS-Task intact:
#      list, GET, DELETE — what does the strict run-state read answer?
#   B  w2bt3's X-ANAS-Task line hand-corrupted (the JSON no longer parses), unit otherwise loadable:
#      the list omits it; GET; DELETE → 202 removes both files?
#   C  the fail-closed refusal itself, INJECTED: /usr/bin/systemctl bind-mounted (for the length of
#      one request) by a wrapper that exits 1 for `show anas-backup-w2bt1.service …` — the exact
#      stderr shape of row 2's case (iv) — and execs a copy of the real binary for everything else.
#      DELETE w2bt1 → 409? Then the bind mount removed and the same DELETE → 202.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
units() { node "ls -l /etc/systemd/system | grep -E 'anas-backup-w2bt' || echo '  (no anas-backup-w2bt* units)'"; }
list() { say "GET /backup/tasks (names)"; local r; r=$(api GET /backup/tasks); grep '^HTTP' <<<"$r"
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d=d.get("data",d); t=d.get("tasks",d) if isinstance(d,dict) else d; print([(x.get("task") or x).get("name") for x in t]); w=d.get("warnings") if isinstance(d,dict) else None; print("warnings:", w)' "$(json_of "$r")" 2>&1; }
delete() { say "DELETE /backup/tasks/$1"; local r; r=$(api DELETE /backup/tasks/$1); echo "$r"; local id; id=$(job_of "$r")
  [ -n "$id" ] && { wait_job "$id" 60; echo "final: $LAST_JOB"; }; }

say "A — w2bt2: a unit systemd cannot load (ExecStart= removed)"
node 'sed -i "/^ExecStart=/d" /etc/systemd/system/anas-backup-w2bt2.service; systemctl daemon-reload
  cat /etc/systemd/system/anas-backup-w2bt2.service; systemctl show anas-backup-w2bt2.service -p LoadState,LoadError,ActiveState; echo "exit $?"'
list
say "GET /backup/tasks/w2bt2"; api GET /backup/tasks/w2bt2 | cut -c1-400
units; delete w2bt2; units
node 'journalctl -u anasd --since -1min --no-pager -o cat | grep -E "w2bt2" | tail -5'

say "B — w2bt3: X-ANAS-Task hand-corrupted"
node 'sed -i "s/^# X-ANAS-Task={\"name\"/# X-ANAS-Task={name/" /etc/systemd/system/anas-backup-w2bt3.service; systemctl daemon-reload
  grep X-ANAS-Task /etc/systemd/system/anas-backup-w2bt3.service | cut -c1-80; systemctl show anas-backup-w2bt3.service -p LoadState,ActiveState; echo "exit $?"'
list
say "GET /backup/tasks/w2bt3"; api GET /backup/tasks/w2bt3 | cut -c1-400
units; delete w2bt3; units
node 'journalctl -u anasd --since -1min --no-pager -o cat | grep -E "w2bt3" | tail -5'

say "C — the fail-closed refusal, injected (systemctl show of anas-backup-w2bt1.service exits 1)"
node 'set -e; mkdir -p /var/tmp/w2b; cp /usr/bin/systemctl /var/tmp/w2b/systemctl.real
cat > /var/tmp/w2b/systemctl.wrap <<'"'"'WRAP'"'"'
#!/bin/sh
if [ "$1" = show ] && [ "$2" = anas-backup-w2bt1.service ]; then
  echo "Failed to get properties: injected by the w2b node pass" >&2; exit 1
fi
exec /var/tmp/w2b/systemctl.real "$@"
WRAP
chmod 755 /var/tmp/w2b/systemctl.wrap; mount --bind /var/tmp/w2b/systemctl.wrap /usr/bin/systemctl; set +e
/usr/bin/systemctl show anas-backup-w2bt1.service -p ActiveState; echo "wrapped show exit $?"
/usr/bin/systemctl is-active anasd; echo "pass-through exit $?"'
say "DELETE /backup/tasks/w2bt1 (systemctl show refuses)"; api DELETE /backup/tasks/w2bt1
node 'umount /usr/bin/systemctl; findmnt /usr/bin/systemctl || echo "bind mount removed"; sha256sum /usr/bin/systemctl /var/tmp/w2b/systemctl.real | cut -c1-16,65-; rm -f /var/tmp/w2b/systemctl.real /var/tmp/w2b/systemctl.wrap'
node 'journalctl -u anasd --since -1min --no-pager -o cat | grep -E "w2bt1" | tail -5'
units; delete w2bt1; units
list
