#!/usr/bin/env bash
# Row 6 (cr.47 (c) and (e), EPICS line 253) — PURE ZFS, no ANAS code. Throwaway pool `w2z`
# on a 1 GiB sparse file. The tree, rebuilt before every case:
#     w2z/p            @s
#     w2z/p/a          @s          (a sibling that sorts BEFORE the held child)
#     w2z/p/a/g        @s
#     w2z/p/c          @s  ← the held / busy one
#     w2z/p/c/g        @s
#     w2z/p/z          @s          (a sibling that sorts AFTER it)
# 32 MiB of random data in w2z/p/c so a send of c@s outlasts the pipe buffer.
# Each case: the command, its exit code, stdout, stderr, then `zfs list -t all -r w2z`.
#   (e)  zfs destroy -r w2z/p                with `zfs hold keep w2z/p/c@s`
#   (c1) zfs destroy -r w2z/p@s              with the hold
#   (c2) zfs rename -r w2z/p@s w2z/p@t       with the hold
#   (c3) zfs rename -r w2z/p@s w2z/p@t       while `zfs send w2z/p/c@s` is running (no hold)
#   (c4) zfs destroy -r w2z/p@s              while the same send is running (no hold)
#   holds: zfs holds -H on a held, an unheld and a nonexistent snapshot
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
node 'bash -s' <<'NODE'
set -u
W=/var/tmp/w2; mkdir -p $W
cap() { local out err rc; out=$(mktemp -p $W); err=$(mktemp -p $W); "$@" >"$out" 2>"$err"; rc=$?
  echo "\$ $*"; echo "exit code: $rc"; echo "stdout:"; sed "s/^/  | /" "$out"; echo "stderr:"; sed "s/^/  | /" "$err"; rm -f "$out" "$err"; }
listing() { echo "zfs list -t all -r -o name w2z  (after):"; zfs list -H -t all -r -o name w2z | sed 's/^/  | /'; }
build() {
  zpool destroy w2z 2>/dev/null; rm -f $W/w2z.img
  truncate -s 1G $W/w2z.img && zpool create -O mountpoint=/w2z w2z $W/w2z.img
  for d in p p/a p/a/g p/c p/c/g p/z; do zfs create w2z/$d; done
  head -c 32M /dev/urandom > /w2z/p/c/data
  zfs snapshot -r w2z/p@s
}
send_bg() { # a send of w2z/p/c@s blocked on a pipe nobody reads for 40 s
  ( zfs send w2z/p/c@s | (sleep 40; cat >/dev/null) ) &
  SENDJOB=$!
  sleep 2; echo "send running: $(pgrep -af 'zfs send w2z/p/c@s' | head -1)"
}
stop_send() { pkill -f 'zfs send w2z/p/c@s'; pkill -f 'sleep 40'; wait 2>/dev/null; }
echo "zfs $(zfs version | head -1), kernel $(uname -r)"

echo; echo "==================== (e) zfs destroy -r of the parent filesystem, child@s held"
build; zfs hold keep w2z/p/c@s; echo "before:"; zfs list -H -t all -r -o name w2z | sed 's/^/  | /'
cap zfs destroy -r w2z/p
listing
zfs release keep w2z/p/c@s 2>/dev/null

echo; echo "==================== (e') the same, dry-run first: zfs destroy -rnv w2z/p (held)"
build; zfs hold keep w2z/p/c@s
cap zfs destroy -rnv w2z/p
listing
zfs release keep w2z/p/c@s

echo; echo "==================== (c1) zfs destroy -r w2z/p@s, child@s held"
build; zfs hold keep w2z/p/c@s
cap zfs destroy -r w2z/p@s
listing
zfs release keep w2z/p/c@s

echo; echo "==================== (c2) zfs rename -r w2z/p@s w2z/p@t, child@s held"
build; zfs hold keep w2z/p/c@s
cap zfs rename -r w2z/p@s w2z/p@t
listing
cap zfs holds -H -r w2z/p@t
zfs release keep w2z/p/c@t 2>/dev/null; zfs release keep w2z/p/c@s 2>/dev/null

echo; echo "==================== (c3) zfs rename -r w2z/p@s w2z/p@t while zfs send w2z/p/c@s runs (no hold)"
build; send_bg
cap zfs holds -H w2z/p/c@s
cap zfs rename -r w2z/p@s w2z/p@t
listing
stop_send

echo; echo "==================== (c4) zfs destroy -r w2z/p@s while zfs send w2z/p/c@s runs (no hold)"
build; send_bg
cap zfs destroy -r w2z/p@s
listing
stop_send

echo; echo "==================== (c5) zfs destroy (single, not -r) w2z/p/c@s while the send runs"
build; send_bg
cap zfs destroy w2z/p/c@s
listing
stop_send

echo; echo "==================== holds"
build; zfs hold keep w2z/p/c@s
cap zfs holds -H w2z/p/c@s
cap zfs holds -H w2z/p@s
cap zfs holds -H w2z/p@nope
cap zfs holds -H -r w2z/p@s
zfs release keep w2z/p/c@s

echo; echo "==================== teardown"
zpool destroy w2z; rm -f $W/w2z.img; rmdir /w2z 2>/dev/null; zpool list -H -o name; ls -A $W
NODE
