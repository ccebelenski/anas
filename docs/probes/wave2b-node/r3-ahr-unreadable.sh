#!/usr/bin/env bash
# Row 3 (cr.33c): what the daemon derives from readAhrPools when `mdadm --detail` fails for the
# array of a LIVE AHR pool (w2bahr, r3-ahr-fixture.sh; the backup task w2bt4 on /mnt/anas-ahr/w2bahr,
# repo w2bbh → the blackholed 192.0.2.10, so the run sits ~10 s in pbc's connect and then fails —
# nothing is written to any PBS).
# Three modes, each for the length of its reads and one direct run, nothing on disk edited:
#   R  readable           — the real /usr/sbin/mdadm
#   A  mdadm EXITS 1      — /usr/sbin/mdadm bind-mounted by a wrapper that answers exactly
#                           `--detail --export /dev/md127` with exit 1 + a "cannot open" stderr and
#                           execs a copy of the real binary for every other argv
#   B  mdadm NOT EXECUTABLE — /usr/sbin/mdadm bind-mounted by a mode-0644 copy (spawn → EACCES)
# Per mode: GET /ahr (names), GET /ahr/w2bahr, POST /backup/tasks/preview-nested (the consistency
# the wizard shows), POST /backup/tasks/w2bt4/run {"direct":true} with anasd's LIVE lock table read
# at t+3 s (wave-3's held-locks.mjs through the V8 inspector), then the job's progress lines.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
HERE="$(cd "$(dirname "$0")" && pwd)"
scp -q -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$HERE/../wave3-node/held-locks.mjs" root@192.168.200.50:/var/tmp/w2b/held-locks.mjs
node 'kill -USR1 $(systemctl show -p MainPID --value anasd); sleep 1; curl -s http://127.0.0.1:9229/json/list | grep -c webSocketDebuggerUrl'
MD=$(node "readlink -f /dev/md/w2bahr-r1" | xargs basename)
echo "array: /dev/md/w2bahr-r1 -> /dev/$MD"
reads() {
  say "[$1] GET /ahr (pool names)"; local r; r=$(api GET /ahr); grep '^HTTP' <<<"$r"
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print([(p.get("name"), p.get("health") or p.get("status")) for p in d.get("data",[])] if "data" in d else d)' "$(json_of "$r")"
  say "[$1] GET /ahr/w2bahr"; api GET /ahr/w2bahr | cut -c1-300
  say "[$1] POST /backup/tasks/preview-nested {path: /mnt/anas-ahr/w2bahr}"
  r=$(api POST /backup/tasks/preview-nested '{"path":"/mnt/anas-ahr/w2bahr"}'); grep '^HTTP' <<<"$r"
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d=d.get("data",d)
for s in (d.get("archives") or d.get("scans") or [d]):
    print("  path:", s.get("path"), "| consistency:", json.dumps(s.get("consistency")))' "$(json_of "$r")" 2>&1 || echo "$r"
  say "[$1] POST /backup/tasks/w2bt4/run {direct:true}"
  r=$(api POST /backup/tasks/w2bt4/run '{"direct":true}'); echo "$r"; local id; id=$(job_of "$r")
  sleep 3; echo "live lock table at t+3 s:"; node 'node /var/tmp/w2b/held-locks.mjs 2>&1 | sed "s/^/  /"'
  [ -n "$id" ] && { wait_job "$id" 90; echo "final: $LAST_JOB"; }
  node "journalctl -u anasd --since -40s --no-pager -o cat | grep -iE 'ahr|w2bt4' | grep -v 'incoming request\|request completed' | tail -6"
}
WRAP='mkdir -p /var/tmp/w2b; cp /usr/sbin/mdadm /var/tmp/w2b/mdadm.real'

reads R

say "mode A: mdadm --detail --export /dev/$MD exits 1"
node "$WRAP
cat > /var/tmp/w2b/mdadm.wrap <<WR
#!/bin/sh
if [ \"\\\$*\" = \"--detail --export /dev/$MD\" ]; then echo \"mdadm: cannot open /dev/$MD: injected by the w2b node pass\" >&2; exit 1; fi
exec /var/tmp/w2b/mdadm.real \"\\\$@\"
WR
chmod 755 /var/tmp/w2b/mdadm.wrap; cat /var/tmp/w2b/mdadm.wrap; mount --bind /var/tmp/w2b/mdadm.wrap /usr/sbin/mdadm
/usr/sbin/mdadm --detail --export /dev/$MD; echo \"wrapped exit \$?\"; /usr/sbin/mdadm --detail --export /dev/md/w2bahr-r1 | head -2; echo \"other argv exit \$?\""
reads A
node 'umount /usr/sbin/mdadm; findmnt /usr/sbin/mdadm || echo "bind mount removed"'

say "mode B: /usr/sbin/mdadm not executable (EACCES)"
node "$WRAP; cp /usr/sbin/mdadm /var/tmp/w2b/mdadm.noexec; chmod 644 /var/tmp/w2b/mdadm.noexec; mount --bind /var/tmp/w2b/mdadm.noexec /usr/sbin/mdadm
/usr/sbin/mdadm --version; echo \"exec exit \$?\""
reads B
node 'umount /usr/sbin/mdadm; findmnt /usr/sbin/mdadm || echo "bind mount removed"'

say "restore check"
node 'sha256sum /usr/sbin/mdadm /var/tmp/w2b/mdadm.real | cut -c1-16,65-; ls -l /usr/sbin/mdadm; rm -f /var/tmp/w2b/mdadm.*; sha256sum /etc/mdadm/mdadm.conf; ls /etc/lvm/archive | wc -l'
reads R2
