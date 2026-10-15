#!/usr/bin/env bash
# Row 1 setup (WAVE2-DESIGN §8 "Setup"): the seven @pve test users and their ACLs, exactly
# as the table names them, then the §7 captures (user.cfg, per-user /access/permissions,
# .members of the standalone node). `down` removes them all.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
CAP="$(cd "$(dirname "$0")" && pwd)/out/captures"; mkdir -p "$CAP"
PW=anas-w2-pw
case "${1:-up}" in
up)
node "set -x
pveum user add anas-audit@pve  --password $PW; pveum acl modify / --users anas-audit@pve --roles PVEAuditor
pveum user add anas-admin@pve  --password $PW; pveum acl modify / --users anas-admin@pve --roles Administrator
pveum user add anas-none@pve   --password $PW
pveum user add anas-np@pve     --password $PW; pveum acl modify / --users anas-np@pve --roles Administrator --propagate 0
pveum user add anas-node@pve   --password $PW; pveum acl modify /nodes/anas-pve --users anas-node@pve --roles Administrator
pveum group add anas-g; pveum user add anas-gm@pve --password $PW --groups anas-g; pveum acl modify / --groups anas-g --roles PVEAuditor
pveum user add anas-off@pve    --password $PW; pveum acl modify / --users anas-off@pve --roles Administrator
set +x
pveum user list --output-format json | python3 -c 'import json,sys; [print(u[\"userid\"], u.get(\"enable\"), u.get(\"groups\",\"\")) for u in json.load(sys.stdin)]'
pveum acl list --output-format json | python3 -c 'import json,sys; [print(a) for a in json.load(sys.stdin)]'"
# §7 captures
node cat /etc/pve/user.cfg > "$CAP/user.cfg"
node cat /etc/pve/.members > "$CAP/members-standalone.json"
for u in root@pam anas-audit@pve anas-admin@pve anas-none@pve anas-np@pve anas-node@pve anas-gm@pve anas-off@pve; do
  node "pvesh get /access/permissions --userid $u --path / --output-format json" > "$CAP/permissions-${u%@*}.json" 2>&1
  echo "$u / -> $(cat "$CAP/permissions-${u%@*}.json")"
done
node "pvesh get /access/permissions --userid anas-node@pve --output-format json" > "$CAP/permissions-anas-node-allpaths.json" 2>&1
echo "anas-node@pve (all paths) -> $(cat "$CAP/permissions-anas-node-allpaths.json")"
echo "--- .members"; cat "$CAP/members-standalone.json"
;;
down)
node "for u in anas-audit anas-admin anas-none anas-np anas-node anas-gm anas-off; do pveum user delete \$u@pve; done; pveum group delete anas-g; pveum acl list --output-format json; pveum user list --output-format json | python3 -c 'import json,sys; print(sorted(u[\"userid\"] for u in json.load(sys.stdin)))'"
;;
esac
