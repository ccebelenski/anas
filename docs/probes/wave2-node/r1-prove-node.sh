#!/usr/bin/env bash
# Row 1 (cr.27, §8 rows 3-8): `prove` on the node.
#  (1) the shipped Perl suite (packages/pve-integration/perl/t — pure helpers and the
#      handler against transliterated fakes) with the node's own perl;
#  (2) AnasProxy-node.t against the REAL PVE modules as www-data, with tickets and CSRF
#      tokens from real /access/ticket logins; anas-off is disabled for the run and
#      re-enabled after.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
HERE="$(cd "$(dirname "$0")" && pwd)"
say "(1) the shipped suite, node perl $(node 'perl -e "print \$^V"')"
node 'cd /opt/anas && prove -I packages/pve-integration/perl packages/pve-integration/perl/t 2>&1 | tail -8'
say "(2) AnasProxy-node.t, real PVE modules, as www-data"
node 'mkdir -p /var/tmp/w2 && chmod 755 /var/tmp/w2'
node 'cat > /var/tmp/w2/AnasProxy-node.t && chmod 644 /var/tmp/w2/AnasProxy-node.t' < "$HERE/AnasProxy-node.t"
cred=$(node 'python3 - <<EOF
import json, subprocess
out = {}
for u, pw in [("root@pam","anas-test")] + [(f"anas-{n}@pve","anas-w2-pw") for n in ("admin","audit","none","np","node","gm","off")]:
    r = subprocess.run(["curl","-sk","-d",f"username={u}","--data-urlencode",f"password={pw}","https://127.0.0.1:8006/api2/json/access/ticket"],capture_output=True,text=True)
    d = json.loads(r.stdout)["data"]; out[u] = [d["ticket"], d["CSRFPreventionToken"]]
print(json.dumps(out))
EOF')
node 'pveum user modify anas-off@pve --enable 0 && echo "anas-off@pve disabled for the run"'
node "cd /var/tmp/w2 && sudo -u www-data env W2_CRED='$cred' prove -v AnasProxy-node.t 2>&1"
rc=$?
node 'pveum user modify anas-off@pve --enable 1 && echo "anas-off@pve re-enabled"; rm -f /var/tmp/w2/AnasProxy-node.t'
exit $rc
