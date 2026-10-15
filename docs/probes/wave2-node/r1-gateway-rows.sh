#!/usr/bin/env bash
# Row 1 (cr.27), the rows that touch the gateway process or the key:
#   12  stop the gateway → a request → 502 + the _respond_502 journal line; start → 200 with a new key
#   14  latency of GET /v1/pools through /anas, 20 runs on the node (curl -w time_total)
#   17b a second install with nothing changed → no pveproxy reload
#   18  a signed target with %2F and a query through real pveproxy → 200, no [authz] line
#   19  /run/anas/proxy.key: mode/owner; www-data reads it, a third uid cannot (sudo -u)
#   20  key rotation: restart the gateway while hammering /anas; count the 401s; no pveproxy restart
#   r1-gateway-rows.sh [row…]     (default: 19 18 14 12 20 17b)
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
NODEIP=192.168.200.50
TICKET=$(curl -sk -d username=root@pam --data-urlencode password=anas-test "https://$NODEIP:8006/api2/json/access/ticket" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["ticket"])')
mark() { MARK=$(node 'date +"%Y-%m-%d %H:%M:%S"'); }
for r in ${*:-19 18 14 12 20 17b}; do case $r in
19) say "row 19 — who can read /run/anas/proxy.key"
   node 'stat -c "%A %U:%G %s bytes %n" /run/anas /run/anas/proxy.key
         echo "www-data:  $(sudo -u www-data head -c 64 /run/anas/proxy.key | wc -c) bytes read, exit ${PIPESTATUS[0]}"
         echo "nobody:    $(sudo -u nobody head -c 64 /run/anas/proxy.key 2>&1)"; sudo -u nobody true
         echo "debian(1000): $(sudo -u debian head -c 64 /run/anas/proxy.key 2>&1)"
         echo "pveproxy worker uid: $(ps -o user= -p $(pgrep -f "^pveproxy worker" | head -1))"' ;;
18) say "row 18 — a signed target with %2F in the path and a query, through real pveproxy"; mark
   for p in '/shares/nfs/%2Ftestpool%2Fshare1?w2=a%2Fb&x=1' '/shares/nfs/%2Ftestpool%2Fshare1/access?w2=%2F' '/pools/gtbackup/datasets/cloudsrc%2Fx?probe=1'; do
     echo "> GET $p"
     curl -sk -w '\n  HTTP %{http_code}\n' -b "PVEAuthCookie=$TICKET" "https://$NODEIP:8006/anas/api/nodes/anas-pve/v1$p" | cut -c1-300 | sed 's/^/  /'
   done
   node "echo '  journal since $MARK:'; journalctl -u anas --since '$MARK' --no-pager -o cat | grep -a authz | sed 's/^/    anas| /'; journalctl -u pveproxy --since '$MARK' --no-pager -o cat | grep -a anas-proxy | sed 's/^/    pveproxy| /'; echo '    (end)'"
   node "grep -a '%2F' /var/log/pveproxy/access.log | tail -3" | sed 's/^/  access.log: /' ;;
14) say "row 14 — latency of GET /v1/pools through /anas, 20 runs on the node (loopback, one TLS handshake each)"
   node "for i in \$(seq 20); do curl -sk -o /dev/null -w '%{time_total}\n' -b 'PVEAuthCookie=$TICKET' https://127.0.0.1:8006/anas/api/nodes/anas-pve/v1/pools; done | sort -n | awk '{a[NR]=\$1} END {printf \"  n=%d min %.4f median %.4f max %.4f s\n\", NR, a[1], (a[10]+a[11])/2, a[NR]}'
         echo '  the same 20 runs against PVE /api2/json/version (PVE ticket check, no ANAS):'
         for i in \$(seq 20); do curl -sk -o /dev/null -w '%{time_total}\n' -b 'PVEAuthCookie=$TICKET' https://127.0.0.1:8006/api2/json/version; done | sort -n | awk '{a[NR]=\$1} END {printf \"  /api2/json/version n=%d min %.4f median %.4f max %.4f s\n\", NR, a[1], (a[10]+a[11])/2, a[NR]}'
         echo '  the daemon alone over its socket, 20 runs:'
         for i in \$(seq 20); do curl -s -o /dev/null -w '%{time_total}\n' --unix-socket /run/anas/anasd.sock -H 'x-anas-user: root@pam' -H 'x-anas-privileges: Sys.Audit' http://localhost/v1/pools; done | sort -n | awk '{a[NR]=\$1} END {printf \"  socket n=%d min %.4f median %.4f max %.4f s\n\", NR, a[1], (a[10]+a[11])/2, a[NR]}'" ;;
12) say "row 12 — systemctl stop anas, then a request; start again"; mark
   node 'ls -li /run/anas/proxy.key; systemctl stop anas; echo "stopped at $(date +%T)"; ls -li /run/anas/proxy.key 2>&1'
   curl -sk -w '\n  HTTP %{http_code} %{time_total}s\n' -b "PVEAuthCookie=$TICKET" "https://$NODEIP:8006/anas/api/nodes/anas-pve/v1/pools" | sed 's/^/  /'
   curl -sk -w '\n  HTTP %{http_code} %{time_total}s (presence probe)\n' "https://$NODEIP:8006/anas/installed" | sed 's/^/  /'
   node "journalctl -u pveproxy --since '$MARK' --no-pager -o cat | grep -a anas-proxy | sed 's/^/    pveproxy| /'"
   node 'systemctl start anas; until curl -sf http://127.0.0.1:3000/installed >/dev/null; do sleep 0.2; done; echo "started at $(date +%T)"; ls -li /run/anas/proxy.key'
   curl -sk -o /dev/null -w '  after start: HTTP %{http_code} %{time_total}s\n' -b "PVEAuthCookie=$TICKET" "https://$NODEIP:8006/anas/api/nodes/anas-pve/v1/pools"
   node 'systemctl show -p MainPID pveproxy; pgrep -f "^pveproxy worker" | tr "\n" " "; echo' ;;
20) say "row 20 — key rotation: restart the gateway while 4 loops hammer /anas for 12 s"; mark
   node "bash -s -- '$TICKET' '$MARK'" < "$(dirname "$0")/r1-row20-node.sh"
   curl -sk -o /dev/null -w '  after: HTTP %{http_code}\n' -b "PVEAuthCookie=$TICKET" "https://$NODEIP:8006/anas/api/nodes/anas-pve/v1/pools" ;;
17b) say "row 17b — a second install with nothing changed"; mark
   node 'systemctl show -p MainPID pveproxy; echo workers $(pgrep -f "^pveproxy worker" | tr "\n" " ")
         /opt/anas/packages/pve-integration/install.sh 2>&1 | grep -i -E "proxy|pveproxy|AnasProxy"
         systemctl show -p MainPID pveproxy; echo workers $(pgrep -f "^pveproxy worker" | tr "\n" " ")'
   node "journalctl -u pveproxy --since '$MARK' --no-pager -o cat | grep -aiE 'reload|HUP|restart' || echo '  (no reload/HUP/restart in the pveproxy journal)'" ;;
esac; done
