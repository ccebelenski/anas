#!/usr/bin/env bash
# Row 1 (cr.47e / cr.47(c)) — PURE ZFS first, no ANAS code. Throwaway pool `w2bz` on a
# 1 GiB sparse file under /var/tmp/w2b. Each case rebuilds the pool, then prints the
# command, its exit code, stdout, stderr, and `zfs list -t all -r w2bz` after.
#
# (a)  clone origin OUTSIDE the tree:
#        w2bz/t  w2bz/t/a  w2bz/t/o (the origin)  w2bz/t/o/g  w2bz/t/z   + `zfs snapshot -r w2bz/t@s`
#        w2bz/c = a clone of w2bz/t/o@s             (outside w2bz/t)
#      a1  zfs destroy -r w2bz/t
#      a2  zfs destroy -rnv w2bz/t                (does the dry run see the clone?)
#      a3  the clone INSIDE the tree instead (w2bz/t/k = clone of w2bz/t/o@s): zfs destroy -r w2bz/t
# (b)  a ZVOL child with a snapshot:
#        w2bz/t  w2bz/t/a  w2bz/t/v (zvol, 16M)  w2bz/t/z   + `zfs snapshot -r w2bz/t@s`
#      b0  zfs list -H -t snapshot -r -o name -- w2bz/t     (the sweep ANAS reads, zfsSweepSnapshotListArgs)
#      b1  zfs destroy -r w2bz/t
#      b2  the same with `zfs hold keep w2bz/t/v@s`: zfs holds -H on the sweep, then zfs destroy -r w2bz/t
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
node 'bash -s' <<'NODE'
set -u
W=/var/tmp/w2b; mkdir -p $W
cap() { local out err rc; out=$(mktemp -p $W); err=$(mktemp -p $W); "$@" >"$out" 2>"$err"; rc=$?
  echo "\$ $*"; echo "exit code: $rc"; echo "stdout:"; sed "s/^/  | /" "$out"; echo "stderr:"; sed "s/^/  | /" "$err"; rm -f "$out" "$err"; }
listing() { echo "zfs list -t all -r -o name,type,origin w2bz  (after):"; zfs list -H -t all -r -o name,type,origin w2bz | sed 's/^/  | /'; }
before() { echo "before:"; zfs list -H -t all -r -o name,type,origin w2bz | sed 's/^/  | /'; }
pool() { zpool destroy w2bz 2>/dev/null; rm -f $W/w2bz.img
  truncate -s 1G $W/w2bz.img && zpool create -O mountpoint=/w2bz w2bz $W/w2bz.img; }
build_a() { pool
  for d in t t/a t/o t/o/g t/z; do zfs create w2bz/$d; done
  head -c 4M /dev/urandom > /w2bz/t/o/data
  zfs snapshot -r w2bz/t@s
  zfs clone w2bz/t/o@s ${1:-w2bz/c}; }
build_b() { pool
  zfs create w2bz/t; zfs create w2bz/t/a; zfs create -V 16M w2bz/t/v; zfs create w2bz/t/z
  udevadm settle; dd if=/dev/urandom of=/dev/zvol/w2bz/t/v bs=1M count=4 status=none
  zfs snapshot -r w2bz/t@s; }
echo "zfs $(zfs version | head -1), kernel $(uname -r)"

echo; echo "==================== (a1) zfs destroy -r of a tree whose child w2bz/t/o@s is the origin of w2bz/c (outside the tree)"
build_a; before
cap zfs destroy -r w2bz/t
listing

echo; echo "==================== (a2) the same tree, dry run: zfs destroy -rnv w2bz/t"
build_a
cap zfs destroy -rnv w2bz/t
listing

echo; echo "==================== (a3) the clone INSIDE the tree (w2bz/t/k = clone of w2bz/t/o@s): zfs destroy -r w2bz/t"
build_a w2bz/t/k; before
cap zfs destroy -r w2bz/t
listing

echo; echo "==================== (b0) a zvol child with a snapshot: the sweep ANAS reads"
build_b; before
cap zfs list -H -t snapshot -r -o name -- w2bz/t

echo; echo "==================== (b1) zfs destroy -r w2bz/t (zvol child w2bz/t/v with w2bz/t/v@s)"
cap zfs destroy -r w2bz/t
listing

echo; echo "==================== (b2) the same with the zvol's snapshot HELD (zfs hold keep w2bz/t/v@s)"
build_b; zfs hold keep w2bz/t/v@s
cap zfs holds -H w2bz/t@s w2bz/t/a@s w2bz/t/v@s w2bz/t/z@s
cap zfs destroy -r w2bz/t
listing
zfs release keep w2bz/t/v@s 2>/dev/null

echo; echo "==================== cleanup"
zpool destroy w2bz; rm -f $W/w2bz.img; zpool list -H -o name | sed 's/^/  pool: /'
NODE
