#!/usr/bin/env bash
# Row 5 (cr.29/29b/29c/29d, routes/share-identity.ts) on the real node, through /anas as
# root@pam. Pool w2id from r5-zfs-space-captures.sh up (w2id/fs mounted, w2id/unm
# unmounted, w2id/enc encrypted + locked, w2id/vol a zvol). Objects: users w2u*, groups w2g*.
#   r5-identity.sh run | down
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
A="$(dirname "$0")/a.sh"
J0=$(node 'date "+%Y-%m-%d %H:%M:%S"')
create() { # path body → prints the answer and, for a 202, the job's end
  local out; out=$("$A" POST "$1" "$2" 2>&1); echo "$out" | head -3 | sed 's/^/  /'
  local c; c=$(code_of "$out"); LASTCODE=$c
  local id; id=$(job_of "$out"); [ -n "$id" ] && "$A" wait "$id" 60 | tail -1 | cut -c1-400 | sed 's/^/  /'
}
audit() { node "journalctl -u anasd --since '$J0' --no-pager -o cat | grep -a '\"audit\":true' | grep -aE '\"identity\\.|user\\.|group\\.' | grep -aE 'job.submitted|job.completed|job.refused' \
  | python3 -c 'import json,sys
for l in sys.stdin:
    try: d=json.loads(l)
    except Exception: continue
    print(\"  \", d.get(\"event\"), d.get(\"operation\"), json.dumps(d.get(\"params\")), json.dumps(d.get(\"result\"))[:200] if d.get(\"result\") else \"\")'"; }
case "${1:-run}" in
run)
say "1a — automatic pick while w2id/enc is LOCKED (and w2id/unm unmounted, w2id/vol a zvol)"
node 'zfs list -r -t all -o name,type,mounted,keystatus w2id; getent passwd | awk -F: "\$3>=1000 && \$3<=60000"'
create /identity/users '{"name":"w2u0"}'
say "1b — the same with w2id/enc unlocked (key loaded, mounted); w2id/unm stays unmounted, the zvol stays"
node 'echo w2passphrase | zfs load-key w2id/enc && zfs mount w2id/enc && zfs list -r -o name,mounted,keystatus w2id'
create /identity/users '{"name":"w2u1"}'
node 'getent passwd w2u1; id w2u1'
say "1c — the group door, automatic gid"
create /identity/groups '{"name":"w2g0"}'
node 'getent group w2g0'

say "2 — an explicit uid held by an account (1000, debian) → 409"
create /identity/users '{"name":"w2u9","uid":1000}'
say "2b — an explicit uid in band that owns files (51099 owns /w2id/fs/owned-51099) → created (an explicit id is never checked for files)"
create /identity/users '{"name":"w2u99","uid":51099}'
node 'getent passwd w2u99; ls -ln /w2id/fs'

say "3 — uid N where gid N is held by an unrelated group: group w2g1 gid 51001, then user w2u2 uid 51001"
create /identity/groups '{"name":"w2g1","gid":51001}'
out=$("$A" POST /identity/users '{"name":"w2u2","uid":51001}' 2>&1); echo "$out" | head -4 | sed 's/^/  /'
c=$(code_of "$out")
echo "> resend with x-anas-confirm: $c"
create /identity/users '{"name":"w2u2","uid":51001}' -H "x-anas-confirm: $c"
out2=$("$A" POST /identity/users '{"name":"w2u2b","uid":51001}' 2>&1); echo "  (a second name on the same uid → $(sed -n 's/^HTTP \([0-9]*\).*/\1/p' <<<"$out2"))"
node 'getent passwd w2u2; id w2u2; getent group w2g1; getent group 51002 51003'
say "3b — the group door's mirror: group w2g2 with gid = an existing user's uid (w2u1)"
u1=$(node 'id -u w2u1')
out=$("$A" POST /identity/groups "{\"name\":\"w2g2\",\"gid\":$u1}" 2>&1); echo "$out" | head -4 | sed 's/^/  /'
c=$(code_of "$out"); [ -n "$c" ] && create /identity/groups "{\"name\":\"w2g2\",\"gid\":$u1}" -H "x-anas-confirm: $c"
node 'getent group w2g2'

say "4 — primaryGroup: a band group (w2g1) and the default 'users'; root refused"
create /identity/users '{"name":"w2u3","uid":51003,"primaryGroup":"w2g1"}'
create /identity/users '{"name":"w2u4","primaryGroup":"users"}'
create /identity/users '{"name":"w2u4r","primaryGroup":"root"}'
node 'id w2u3; id w2u4'

say "5 — a user whose primary group is named like the user: group w2u5 gid 51005, user w2u5 uid 51006 primaryGroup w2u5; delete the user"
create /identity/groups '{"name":"w2u5","gid":51005}'
create /identity/users '{"name":"w2u5","uid":51006,"primaryGroup":"w2u5"}'
node 'id w2u5; grep -E "^USERGROUPS_ENAB" /etc/login.defs'
out=$("$A" DELETE /identity/users/w2u5 2>&1); echo "$out" | head -4 | sed 's/^/  /'
c=$(code_of "$out")
out=$("$A" DELETE /identity/users/w2u5 -H "x-anas-confirm: $c" 2>&1); echo "$out" | head -3 | sed 's/^/  /'
id=$(job_of "$out"); [ -n "$id" ] && "$A" wait "$id" 60 | tail -1 | cut -c1-300 | sed 's/^/  /'
node 'getent passwd w2u5 || echo "  user w2u5 gone"; getent group w2u5 && echo "  group w2u5 SURVIVES"'

say "6 — the automatic pick steps over ids ZFS accounts for, on a mounted AND an unmounted filesystem"
top=$(node 'getent passwd | awk -F: "\$3>=1000 && \$3<=60000 {print \$3}" | sort -n | tail -1'); echo "  highest in-band uid now: $top"
n1=$((top+1)); n2=$((top+2))
node "install -o $n1 -g 0 /dev/null /w2id/fs/owned-$n1; zfs mount w2id/unm && install -o $n2 -g 0 /dev/null /w2id/unm/owned-$n2 && zfs unmount w2id/unm; zfs list -o name,mounted w2id/unm; zfs userspace -Hpn -o name w2id/unm | tr '\n' ' '; echo"
create /identity/users '{"name":"w2u6"}'
node "getent passwd w2u6; echo '  expected: $((top+3)) (skips $n1 on w2id/fs and $n2 on the unmounted w2id/unm)'"

say "audit lines"
audit
;;
down)
for u in w2u0 w2u1 w2u2 w2u2b w2u3 w2u4 w2u4r w2u5 w2u6 w2u7 w2u8 w2u9 w2u99; do
  out=$("$A" DELETE /identity/users/$u 2>&1); c=$(code_of "$out")
  [ -n "$c" ] && out=$("$A" DELETE /identity/users/$u -H "x-anas-confirm: $c" 2>&1)
  id=$(job_of "$out"); [ -n "$id" ] && "$A" wait "$id" 60 | tail -1 | cut -c1-120 | sed "s/^/  $u: /"
done
for g in w2g0 w2g1 w2g2 w2u5 w2u7; do
  out=$("$A" DELETE /identity/groups/$g 2>&1); c=$(code_of "$out")
  [ -n "$c" ] && out=$("$A" DELETE /identity/groups/$g -H "x-anas-confirm: $c" 2>&1)
  id=$(job_of "$out"); [ -n "$id" ] && "$A" wait "$id" 60 | tail -1 | cut -c1-120 | sed "s/^/  $g: /"
done
node 'getent passwd | awk -F: "\$3>=1000 && \$3<=60000"; getent group | awk -F: "\$3>=1000 && \$3<=60000"'
;;
esac
