#!/usr/bin/env bash
# Row 3 (cr.33c): the direct run's unlocked-source line, read with a LOGPOINT (logpoint.mjs) at
# dist/routes/backup.js:1083 — `if (unlocked)`, right after
# `const unlocked = unlockedSourcesLine(source.unlocked)` — because r3b showed the line is
# replaced within a millisecond and polling cannot see it. The same three mdadm modes
# (R readable, A `--detail --export` exits 1, B EACCES), one direct run each over the socket.
# (run 1 logged nothing: its expression carried shell-escaped quotes, a JS syntax error, which a
# breakpoint condition swallows as false — script bug (b); the expression now has no quotes. Run 2,
# with one 75 s nohup'd session for all three runs, logged nothing either, while the same expression
# armed in the run's own ssh session logged at once — so each run now arms its own 16 s session.)
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
HERE="$(cd "$(dirname "$0")" && pwd)"
MD=$(node "readlink -f /dev/md/w2bahr-r1" | xargs basename)
scp -q -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$HERE/logpoint.mjs" root@192.168.200.50:/var/tmp/w2b/logpoint.mjs
node "sed -n '1082,1084p' /opt/anas/packages/daemon/dist/routes/backup.js"
node 'curl -s http://127.0.0.1:9229/json/list | grep -c webSocketDebuggerUrl || { kill -USR1 $(systemctl show -p MainPID --value anasd); sleep 1; }'
T0=$(node 'date "+%Y-%m-%d %H:%M:%S"')
directrun() { say "[$1] direct run of w2bt4 over the socket, logpoint armed for this run only"
  node 'cd /var/tmp/w2b && (node logpoint.mjs "routes/backup\\.js$" 1082 "JSON.stringify({unlocked:unlocked,sourceUnlocked:source.unlocked})" 16 > lp.out 2>&1 &); sleep 2
H=(-H "x-anas-user: root@pam" -H "x-anas-user-uid: 0" -H "x-anas-privileges: Sys.Audit,Sys.Modify")
r=$(curl -s --unix-socket /run/anas/anasd.sock -X POST "${H[@]}" -H "x-anas-request-id: $(cat /proc/sys/kernel/random/uuid)" -H "content-type: application/json" --data "{\"direct\":true}" http://localhost/v1/backup/tasks/w2bt4/run); echo "submit: $r" | cut -c1-120
id=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])[\"job\"][\"id\"])" "$r")
while curl -s --unix-socket /run/anas/anasd.sock -H "x-anas-privileges: Sys.Audit" http://localhost/v1/jobs/$id | grep -q "\"status\":\"running\""; do sleep 1; done; echo "job $id ended"
sleep 4; grep -v "hit tasks\|hit 1083" lp.out; rm -f lp.out'; }
WRAP='mkdir -p /var/tmp/w2b; cp /usr/sbin/mdadm /var/tmp/w2b/mdadm.real'
directrun R
node "$WRAP
cat > /var/tmp/w2b/mdadm.wrap <<WR
#!/bin/sh
if [ \"\\\$*\" = \"--detail --export /dev/$MD\" ]; then echo \"mdadm: cannot open /dev/$MD: injected by the w2b node pass\" >&2; exit 1; fi
exec /var/tmp/w2b/mdadm.real \"\\\$@\"
WR
chmod 755 /var/tmp/w2b/mdadm.wrap; mount --bind /var/tmp/w2b/mdadm.wrap /usr/sbin/mdadm"
directrun A
node 'umount /usr/sbin/mdadm; findmnt /usr/sbin/mdadm || echo "bind mount removed"'
node "$WRAP; cp /usr/sbin/mdadm /var/tmp/w2b/mdadm.noexec; chmod 644 /var/tmp/w2b/mdadm.noexec; mount --bind /var/tmp/w2b/mdadm.noexec /usr/sbin/mdadm"
directrun B
node 'umount /usr/sbin/mdadm; findmnt /usr/sbin/mdadm || echo "bind mount removed"; sha256sum /usr/sbin/mdadm /var/tmp/w2b/mdadm.real | cut -c1-16,65-; rm -f /var/tmp/w2b/mdadm.*'
say "the logpoint's lines in the anasd journal (R, A, B in order)"
node "journalctl -u anasd --since '$T0' --no-pager -o short-iso | grep W2B-LOGPOINT || echo \"(none)\""
