#!/usr/bin/env bash
# Row 6 addendum (cr.47 (c)): (c3) showed `zfs rename -r` succeeds while a `zfs send` reads
# a snapshot in the tree. Does that send still complete, and what name does the received
# snapshot carry? A send of w2z/p/c@s piped through a 6 s pause into `zfs recv w2z/r`; the
# rename -r happens during the pause.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
node 'bash -s' <<'NODE'
set -u
W=/var/tmp/w2; mkdir -p $W
zpool destroy w2z 2>/dev/null; rm -f $W/w2z.img
truncate -s 1G $W/w2z.img && zpool create -O mountpoint=/w2z w2z $W/w2z.img
for d in p p/c p/c/g; do zfs create w2z/$d; done
head -c 32M /dev/urandom > /w2z/p/c/data; zfs snapshot -r w2z/p@s
( zfs send w2z/p/c@s | (sleep 6; cat) | zfs recv w2z/r; echo "pipeline exit codes: send/recv ${PIPESTATUS[0]}/${PIPESTATUS[2]}" ) &
sleep 2; echo "send running: $(pgrep -af 'zfs send w2z/p/c@s' | head -1)"
echo "\$ zfs rename -r w2z/p@s w2z/p@t"; zfs rename -r w2z/p@s w2z/p@t; echo "exit code: $?"
wait
zfs list -H -t all -r -o name,used w2z | sed 's/^/  | /'
echo "received data: $(sha256sum /w2z/r/data | cut -c1-16)  source: $(sha256sum /w2z/p/c/data | cut -c1-16)"
zpool destroy w2z; rm -f $W/w2z.img; rmdir /w2z 2>/dev/null; echo "w2z destroyed"
NODE
