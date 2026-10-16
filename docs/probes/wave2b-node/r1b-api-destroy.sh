#!/usr/bin/env bash
# Row 1, through ANAS: DELETE /pools/w2bz/datasets/t?recursive=true (the Datasets panel's
# recursive Destroy) over the two trees r1-zfs-clone-zvol.sh built in pure ZFS.
#   A  the clone-origin tree (w2bz/t/o@s is the origin of w2bz/c, outside the tree) — the hold
#      gate cannot see a clone origin: a refusal, an atomic failure, or a partial destroy?
#   B  the zvol tree with w2bz/t/v@s HELD (zfs hold keep) — 409 snapshot-held naming it (cr.47e)
#   C  the zvol tree, no hold — the confirm, then the job destroys the zvol and its snapshot
# Each case: the node's tree before, every API reply verbatim, the job's end state, the tree after.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
P='/pools/w2bz/datasets/t?recursive=true'
tree() { echo "zfs list -t all -r -o name,type,origin w2bz ($1):"; node "zfs list -H -t all -r -o name,type,origin w2bz | sed 's/^/  | /'"; }
pool() { node 'zpool destroy w2bz 2>/dev/null; mkdir -p /var/tmp/w2b; rm -f /var/tmp/w2b/w2bz.img
  truncate -s 1G /var/tmp/w2b/w2bz.img && zpool create -O mountpoint=/w2bz w2bz /var/tmp/w2b/w2bz.img'; }
build_a() { pool; node 'for d in t t/a t/o t/o/g t/z; do zfs create w2bz/$d; done
  head -c 4M /dev/urandom > /w2bz/t/o/data; zfs snapshot -r w2bz/t@s; zfs clone w2bz/t/o@s w2bz/c'; }
build_b() { pool; node 'zfs create w2bz/t; zfs create w2bz/t/a; zfs create -V 16M w2bz/t/v; zfs create w2bz/t/z
  udevadm settle; dd if=/dev/urandom of=/dev/zvol/w2bz/t/v bs=1M count=4 status=none; zfs snapshot -r w2bz/t@s'; }
destroy_confirmed() {
  say "DELETE $P (challenge)"
  local r1; r1=$(api DELETE "$P"); echo "$r1"
  local c; c=$(code_of "$r1")
  [ -z "$c" ] && { echo "(no confirm code — stopped here)"; return; }
  say "DELETE $P (resend with x-anas-confirm)"
  local r2; r2=$(api DELETE "$P" -H "x-anas-confirm: $c"); echo "$r2"
  local id; id=$(job_of "$r2"); [ -z "$id" ] && return
  say "job $id"
  wait_job "$id" 120; echo "final: $LAST_JOB"
}

say "A — recursive destroy over a clone origin (w2bz/c is a clone of w2bz/t/o@s)"
build_a; tree before
destroy_confirmed
tree after

say "B — recursive destroy over a tree whose ZVOL snapshot w2bz/t/v@s is held"
build_b; node 'zfs hold keep w2bz/t/v@s; zfs holds -H w2bz/t/v@s'; tree before
say "DELETE $P"
api DELETE "$P"
say "DELETE $P with a made-up confirm code (does the gate still answer first?)"
api DELETE "$P" -H 'x-anas-confirm: 00000000'
tree after
node 'zfs release keep w2bz/t/v@s'

say "C — the same zvol tree, hold released"
tree before
destroy_confirmed
tree after

say "cleanup"
node 'zpool destroy w2bz; rm -f /var/tmp/w2b/w2bz.img; zpool list -H -o name'
