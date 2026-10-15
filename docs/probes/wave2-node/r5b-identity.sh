#!/usr/bin/env bash
# Row 5, second part. r5-identity.sh's `create` helper dropped its extra arguments, so its
# items 3 and 3b resent WITHOUT the confirm header (a script bug, class (b)); re-run here
# with the header actually sent. Plus 5b: a user whose like-named primary group is ALSO
# another account's primary group — userdel keeps it, and so must the confirm.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
A="$(dirname "$0")/a.sh"
J0=$(node 'date "+%Y-%m-%d %H:%M:%S"')
create() { # path body [curl args…]
  local out; out=$("$A" POST "$@" 2>&1); echo "$out" | head -4 | sed 's/^/  /'
  LASTCODE=$(code_of "$out")
  local id; id=$(job_of "$out"); [ -n "$id" ] && "$A" wait "$id" 60 | tail -1 | cut -c1-400 | sed 's/^/  /'
}
say "3 — user w2u2 uid 51001 while group w2g1 holds gid 51001: challenge, then resend WITH the code"
create /identity/users '{"name":"w2u2","uid":51001}'
echo "> resend with x-anas-confirm: $LASTCODE"
create /identity/users '{"name":"w2u2","uid":51001}' -H "x-anas-confirm: $LASTCODE"
node 'getent passwd w2u2; id w2u2; getent group w2g1'
say "3b — group w2g2 with gid = w2u1's uid: challenge, then resend WITH the code"
u1=$(node 'id -u w2u1')
create /identity/groups "{\"name\":\"w2g2\",\"gid\":$u1}"
echo "> resend with x-anas-confirm: $LASTCODE"
create /identity/groups "{\"name\":\"w2g2\",\"gid\":$u1}" -H "x-anas-confirm: $LASTCODE"
node 'getent group w2g2'
say "3c — a replayed code after the state changed (w2u2 exists now): the same body + the first code again"
create /identity/users '{"name":"w2u2","uid":51001}' -H "x-anas-confirm: $LASTCODE"

say "5b — group w2u7 (gid 51007) is the primary group of users w2u7 (uid 51008) AND w2u8 (uid 51009); delete w2u7"
create /identity/groups '{"name":"w2u7","gid":51007}'
create /identity/users '{"name":"w2u7","uid":51008,"primaryGroup":"w2u7"}'
create /identity/users '{"name":"w2u8","uid":51009,"primaryGroup":"w2u7"}'
out=$("$A" DELETE /identity/users/w2u7 2>&1); echo "$out" | head -4 | sed 's/^/  /'
c=$(code_of "$out")
out=$("$A" DELETE /identity/users/w2u7 -H "x-anas-confirm: $c" 2>&1); echo "$out" | head -3 | sed 's/^/  /'
id=$(job_of "$out"); [ -n "$id" ] && "$A" wait "$id" 60 | tail -1 | cut -c1-300 | sed 's/^/  /'
node 'getent passwd w2u7 || echo "  user w2u7 gone"; getent group w2u7 && echo "  group w2u7 SURVIVES"; id w2u8'
say "audit"
node "journalctl -u anasd --since '$J0' --no-pager -o cat | grep -a '\"audit\":true' | grep -aE 'job.submitted' | grep -aE 'identity' \
  | python3 -c 'import json,sys
for l in sys.stdin:
    d=json.loads(l); print(\"  \", d.get(\"event\"), d.get(\"operation\"), json.dumps(d.get(\"params\")))'"
