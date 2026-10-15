#!/usr/bin/env bash
# Row 1 (cr.27): WAVE2-DESIGN §8 rows 1-13 and 15 through the real pveproxy, as each
# test user, each with its response line and the journal lines it produced (pveproxy's
# `anas-proxy:` lines and the gateway's `[authz]` lines). Users from r1-setup-users.sh.
#   r1-authz-rows.sh [row…]      (default: all)
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
NODEIP=192.168.200.50
BASE="https://$NODEIP:8006/anas/api/nodes/anas-pve/v1"
PW=anas-w2-pw
declare -A TK CS
login_as() { # user [password]
  local r; r=$(curl -sk --max-time 15 -d "username=$1" --data-urlencode "password=${2:-$PW}" "https://$NODEIP:8006/api2/json/access/ticket")
  TK[$1]=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["ticket"])' <<<"$r")
  CS[$1]=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["CSRFPreventionToken"])' <<<"$r")
}
# as USER METHOD PATH [csrf-of-user|-] → "HTTP <code> <time>" + body
as() {
  local u=$1 m=$2 p=$3 c=${4:-$1}
  local args=(-sk --max-time 30 -X "$m" -w '\nHTTP %{http_code} %{time_total}s\n' -b "PVEAuthCookie=${TK[$u]}")
  [ "$c" != "-" ] && args+=(-H "CSRFPreventionToken: ${CS[$c]}")
  echo "> $u $m $p (csrf: $c)"
  curl "${args[@]}" "$BASE$p" | sed 's/^/  /'
}
mark() { MARK=$(node 'date +"%Y-%m-%d %H:%M:%S"'); }
journal() { # since MARK: pveproxy anas-proxy lines + gateway [authz] lines + daemon FORBIDDEN lines
  echo "  journal since $MARK:"
  node "journalctl -u pveproxy --since '$MARK' --no-pager -o cat | grep -a 'anas-proxy' | sed 's/^/    pveproxy| /'
        journalctl -u anas --since '$MARK' --no-pager -o cat | grep -a 'authz' | sed 's/^/    anas| /' | cut -c1-400
        journalctl -u anasd --since '$MARK' --no-pager -o cat | grep -ai 'forbidden' | sed 's/^/    anasd| /' | cut -c1-400"
}
ROWS=${*:-"1 2 3 4 5 6 7 8 9 10 11 13 15"}
for u in root@pam; do login_as "$u" anas-test; done
for u in anas-audit@pve anas-admin@pve anas-none@pve anas-np@pve anas-node@pve anas-gm@pve anas-off@pve; do login_as "$u"; done
for r in $ROWS; do case $r in
1) say "row 1 — root@pam: GET /pools; POST scrub (gtbackup) with token"; mark
   as root@pam GET /pools | sed -n '1p;$p'
   as root@pam POST /pools/gtbackup/scrub; journal ;;
2) say "row 2 — root@pam: POST scrub without token; with anas-admin's token"; mark
   as root@pam POST /pools/gtbackup/scrub -
   as root@pam POST /pools/gtbackup/scrub anas-admin@pve; journal ;;
3) say "row 3 — anas-audit (PVEAuditor on /): GET /pools; POST scrub with its own token"; mark
   as anas-audit@pve GET /pools | sed -n '1p;$p'
   as anas-audit@pve POST /pools/gtbackup/scrub; journal ;;
4) say "row 4 — anas-none (no ACL): GET /health (panel half: r1-panel-privilege.spec.ts)"; mark
   as anas-none@pve GET /health; journal ;;
5) say "row 5 — anas-np (Administrator on / with --propagate 0): GET and POST"; mark
   as anas-np@pve GET /pools | sed -n '1p;$p'
   as anas-np@pve POST /pools/gtbackup/scrub; journal ;;
6) say "row 6 — anas-node (Administrator on /nodes/anas-pve only): ANAS GET; PVE's own ZFS create for comparison"; mark
   as anas-node@pve GET /pools
   echo "> anas-node POST /api2/json/nodes/anas-pve/disks/zfs (name=w2bogus devices=/dev/w2nonexistent raidlevel=single)"
   curl -sk --max-time 30 -w '\nHTTP %{http_code}\n' -b "PVEAuthCookie=${TK[anas-node@pve]}" -H "CSRFPreventionToken: ${CS[anas-node@pve]}" \
     -d name=w2bogus -d devices=/dev/w2nonexistent -d raidlevel=single "https://$NODEIP:8006/api2/json/nodes/anas-pve/disks/zfs" | sed 's/^/  /'
   echo "> anas-node GET /api2/json/nodes/anas-pve/disks/zfs (PVE's list)"
   curl -sk --max-time 30 -w '\nHTTP %{http_code}\n' -b "PVEAuthCookie=${TK[anas-node@pve]}" "https://$NODEIP:8006/api2/json/nodes/anas-pve/disks/zfs" | sed 's/^/  /' | cut -c1-200
   echo "> root@pam POST the same bogus ZFS create (PVE's answer past the permission check)"
   curl -sk --max-time 30 -w '\nHTTP %{http_code}\n' -b "PVEAuthCookie=${TK[root@pam]}" -H "CSRFPreventionToken: ${CS[root@pam]}" \
     -d name=w2bogus -d devices=/dev/w2nonexistent -d raidlevel=single "https://$NODEIP:8006/api2/json/nodes/anas-pve/disks/zfs" | sed 's/^/  /'
   journal ;;
7) say "row 7 — anas-gm (PVEAuditor through group anas-g): GET; POST"; mark
   as anas-gm@pve GET /pools | sed -n '1p;$p'
   as anas-gm@pve POST /pools/gtbackup/scrub; journal ;;
8) say "row 8 — anas-off: GET with a live ticket, --enable 0, GET again with the same ticket"; mark
   as anas-off@pve GET /pools | sed -n '1p;$p'
   node 'pveum user modify anas-off@pve --enable 0 && echo "  (pveum user modify anas-off@pve --enable 0 at $(date +%T.%N | cut -c1-12))"'
   as anas-off@pve GET /pools; journal
   node 'pveum user modify anas-off@pve --enable 1 && echo "  (re-enabled)"' ;;
9) say "row 9 — direct to the gateway's loopback port, with a valid cookie; with a forged X-Anas-Auth"; mark
   node "curl -s -w '\nHTTP %{http_code}\n' -b 'PVEAuthCookie=${TK[root@pam]}' http://127.0.0.1:3000/api/nodes/anas-pve/v1/pools
         curl -s -w '\nHTTP %{http_code}\n' -b 'PVEAuthCookie=${TK[root@pam]}' -H \"X-Anas-Auth: v1;user=root@pam;privs=Sys.Audit,Sys.Modify;ts=\$(date +%s);mac=\$(printf '%064d' 0)\" http://127.0.0.1:3000/api/nodes/anas-pve/v1/pools
         echo '> through :8006 with a client-supplied X-Anas-Auth (anas-none): AnasProxy strips it'" | sed 's/^/  /'
   echo "> anas-none GET /pools with a forged X-Anas-Auth claiming root@pam"
   curl -sk -w '\nHTTP %{http_code}\n' -b "PVEAuthCookie=${TK[anas-none@pve]}" -H "X-Anas-Auth: v1;user=root@pam;privs=Sys.Audit,Sys.Modify;ts=$(date +%s);mac=00" "$BASE/pools" | sed 's/^/  /'
   journal ;;
10) say "row 10 / row 21 — pvedaemon's :85 serves the hook too: GET http://127.0.0.1:85/anas/installed (and an authenticated path)"; mark
   node "curl -s -w '\nHTTP %{http_code}\n' http://127.0.0.1:85/anas/installed
         curl -s -w '\nHTTP %{http_code}\n' -b 'PVEAuthCookie=${TK[root@pam]}' http://127.0.0.1:85/anas/api/nodes/anas-pve/v1/pools
         echo '  listener:'; ss -ltnp | grep ':85 '" | sed 's/^/  /'
   node "journalctl -u pvedaemon --since '$MARK' --no-pager -o cat | grep -a anas-proxy | sed 's/^/    pvedaemon| /'"
   journal ;;
11) say "row 11 — /anas/installed without a cookie"; mark
   curl -sk -w '\nHTTP %{http_code}\n' "https://$NODEIP:8006/anas/installed" | sed 's/^/  /'; journal ;;
13) say "row 13 — access.log names the user on /anas lines"
   node "grep -a ' /anas/' /var/log/pveproxy/access.log | tail -25" | sed 's/^/  /' ;;
15) say "row 15 — ADOCK's /adock on the same node (no cookie; root cookie)"
   curl -sk -o /dev/null -w '  /adock/ no cookie: HTTP %{http_code}\n' "https://$NODEIP:8006/adock/"
   curl -sk -w '\n  HTTP %{http_code}\n' -b "PVEAuthCookie=${TK[root@pam]}" "https://$NODEIP:8006/adock/installed" | cut -c1-200
   node 'systemctl is-active adock adockd; journalctl -u adock --since "-30min" --no-pager -o cat | grep -ci error' | sed 's/^/  /' ;;
esac; done
