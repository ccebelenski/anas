#!/usr/bin/env bash
# Row 3 follow-up (D12's reach): with the hand-built AHR pool w2bahr up (r3-ahr-fixture.sh up) and
# `mdadm --detail --export` of its array answering exit 1 (mode A), what does the Disks inventory say
# about the pool's two member disks (hot20, hot21)? The disks route reads AHR membership from the
# same readAhrPools (routes/disks.ts:240) and fails soft to "no AHR members".
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
MD=$(node "readlink -f /dev/md/w2bahr-r1" | xargs basename)
disks() {
  say "[$1] GET /disks — the two member disks"
  local r; r=$(api GET /disks); grep '^HTTP' <<<"$r"
  python3 -c 'import json,sys
d=json.loads(sys.argv[1]); d=d.get("data",d); rows=d.get("disks",d) if isinstance(d,dict) else d
for x in rows:
    s=json.dumps(x)
    if "ANAS_HOT20" in s or "ANAS_HOT21" in s:
        keep={k:x.get(k) for k in ("name","serial","status","usage","pool","poolName","ahr","ahrPool","vdevRole","inUse","available","partitions") if k in x}
        print(" ", json.dumps(keep)[:600])' "$(json_of "$r")"
}
disks R
node "mkdir -p /var/tmp/w2b; cp /usr/sbin/mdadm /var/tmp/w2b/mdadm.real
cat > /var/tmp/w2b/mdadm.wrap <<WR
#!/bin/sh
if [ \"\\\$*\" = \"--detail --export /dev/$MD\" ]; then echo \"mdadm: cannot open /dev/$MD: injected by the w2b node pass\" >&2; exit 1; fi
exec /var/tmp/w2b/mdadm.real \"\\\$@\"
WR
chmod 755 /var/tmp/w2b/mdadm.wrap; mount --bind /var/tmp/w2b/mdadm.wrap /usr/sbin/mdadm"
disks A
node 'umount /usr/sbin/mdadm; findmnt /usr/sbin/mdadm || echo "bind mount removed"; sha256sum /usr/sbin/mdadm /var/tmp/w2b/mdadm.real | cut -c1-16,65-; rm -f /var/tmp/w2b/mdadm.*'
disks R2
