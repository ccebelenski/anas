#!/usr/bin/env bash
# Row 3 (cr.33c), the run's FIRST progress line: r3-ahr-unreadable.sh polled through /anas every
# 0.5 s and saw only the consistency line, because the cr.33c "no lock on the source" line is set
# first and replaced within milliseconds. Here the direct run is submitted over anasd's socket ON
# THE NODE and the job is read back-to-back over the socket (no sleep) until it leaves the
# pre-flight, keeping every distinct progress value in order. Same three mdadm modes as
# r3-ahr-unreadable.sh (R readable, A `--detail --export` exits 1, B EACCES), same w2bt4 task.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
MD=$(node "readlink -f /dev/md/w2bahr-r1" | xargs basename)
run() {
  say "[$1] direct run of w2bt4 over the socket, progress read back-to-back"
  node "bash -s" <<'NODE'
S=/run/anas/anasd.sock
H=(-H 'x-anas-user: root@pam' -H 'x-anas-user-uid: 0' -H 'x-anas-privileges: Sys.Audit,Sys.Modify')
r=$(curl -s --unix-socket $S -X POST "${H[@]}" -H "x-anas-request-id: $(cat /proc/sys/kernel/random/uuid)" -H 'content-type: application/json' --data '{"direct":true}' http://localhost/v1/backup/tasks/w2bt4/run)
echo "submit: $r"
id=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["job"]["id"])' "$r")
last=""; n=0; t0=$(date +%s%N)
while :; do
  j=$(curl -s --unix-socket $S -H 'x-anas-privileges: Sys.Audit' http://localhost/v1/jobs/$id); n=$((n+1))
  p=$(python3 -c 'import json,sys; j=json.loads(sys.argv[1]); j=j.get("job",j); print(j.get("status"),"|",j.get("progress") or "")' "$j")
  if [ "$p" != "$last" ]; then echo "  [+$(( ($(date +%s%N)-t0)/1000000 )) ms, read $n] $p"; last=$p; fi
  case "$p" in *"Starting backup"*|failed*|completed*|cancelled*) break ;; esac
done
while :; do j=$(curl -s --unix-socket $S -H 'x-anas-privileges: Sys.Audit' http://localhost/v1/jobs/$id)
  case "$j" in *'"status":"running"'*) sleep 1 ;; *) echo "  end: $(echo "$j" | cut -c1-400)"; break ;; esac; done
NODE
}
WRAP='mkdir -p /var/tmp/w2b; cp /usr/sbin/mdadm /var/tmp/w2b/mdadm.real'
run R
node "$WRAP
cat > /var/tmp/w2b/mdadm.wrap <<WR
#!/bin/sh
if [ \"\\\$*\" = \"--detail --export /dev/$MD\" ]; then echo \"mdadm: cannot open /dev/$MD: injected by the w2b node pass\" >&2; exit 1; fi
exec /var/tmp/w2b/mdadm.real \"\\\$@\"
WR
chmod 755 /var/tmp/w2b/mdadm.wrap; mount --bind /var/tmp/w2b/mdadm.wrap /usr/sbin/mdadm"
run A
node 'umount /usr/sbin/mdadm; findmnt /usr/sbin/mdadm || echo "bind mount removed"'
node "$WRAP; cp /usr/sbin/mdadm /var/tmp/w2b/mdadm.noexec; chmod 644 /var/tmp/w2b/mdadm.noexec; mount --bind /var/tmp/w2b/mdadm.noexec /usr/sbin/mdadm"
run B
node 'umount /usr/sbin/mdadm; findmnt /usr/sbin/mdadm || echo "bind mount removed"; sha256sum /usr/sbin/mdadm /var/tmp/w2b/mdadm.real | cut -c1-16,65-; rm -f /var/tmp/w2b/mdadm.*'
