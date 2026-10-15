#!/usr/bin/env bash
# Wave-3 node pass, N4 (WAVE3-DESIGN §8.3, cr.34/cr.35): is a hung read bounded?
#
# A single-device pool `w3dm` with failmode=wait on a dm-linear in front of a
# loop device over a sparse file under /var/tmp/w3 (never a real disk). The
# device is SUSPENDED with `dmsetup suspend`: I/O queues in the kernel, nothing
# errors, and every process that waits on the pool's I/O sleeps uninterruptibly
# until `dmsetup resume`. Measured: which reads block (§6.4 "needs a node
# check"), what GET /pools, GET /status and GET /health answer and how fast,
# whether the gateway or AnasProxy answers, and the abandoned-child registry.
#
#   n4.sh setup | measure <label> | suspend | write | resume | teardown
set -uo pipefail
source "$(dirname "$0")/lib.sh"
IMG=/var/tmp/w3/w3dm.img
tapi() {  # timed API GET, status + first 300 chars
  local s out; s=$(date +%s%N)
  out=$(MAXTIME=45 "$API" GET "$1" 2>&1)
  printf '  GET %s -> %s in %d ms\n    %s\n' "$1" "$(http_of "$out")" "$(( ($(date +%s%N) - s) / 1000000 ))" "$(json_of "$out" | cut -c1-${2:-300})"
}
case "${1:-}" in
  setup)
    node "set -e; mkdir -p /var/tmp/w3; truncate -s 1G $IMG; L=\$(losetup -f --show $IMG); echo loop=\$L
      dmsetup create w3dm --table \"0 \$(blockdev --getsz \$L) linear \$L 0\"
      zpool create -o failmode=wait -O mountpoint=/w3dm w3dm /dev/mapper/w3dm
      zfs create w3dm/a; dd if=/dev/urandom of=/w3dm/a/seed bs=1M count=16 status=none; zpool sync w3dm
      zpool get -H failmode w3dm; dmsetup table w3dm; zfs list -r -o name,used w3dm" ;;
  measure)
    say "measure: ${2:-}"
    node "for c in 'zpool status w3dm' 'zpool list -H' 'zpool get -H guid w3dm' 'zfs list -H -r w3dm' 'zfs get -H mountpoint w3dm/a' 'zpool status -jv w3dm' 'stat -f /w3dm/a' 'ls /w3dm/a'; do
        s=\$(date +%s%N); ( \$c >/dev/null 2>&1 ) & p=\$!
        for i in \$(seq 1 120); do kill -0 \$p 2>/dev/null || break; sleep 0.1; done
        if kill -0 \$p 2>/dev/null; then printf '  node# %-28s STILL RUNNING after 12 s (pid %s left behind)\\n' \"\$c\" \$p
        else wait \$p; rc=\$?; printf '  node# %-28s rc=%-3s %5d ms\\n' \"\$c\" \$rc \$(( (\$(date +%s%N) - s) / 1000000 )); fi
      done; echo '  D-state:'; ps -eo pid,stat,wchan:22,etime,cmd | awk '\$2 ~ /D/' | head -12"
    tapi /pools 200; tapi /status 400; tapi /health 600; tapi /pools/w3dm/datasets 200 ;;
  reads)  # the wider request path, and what WOULD block (a read of the device itself)
    say "reads: ${2:-}"
    for p in /disks /ahr /mounts /shares/smb /iscsi/health /pools/w3dm; do tapi "$p" 120; done
    node "( blkid -p /dev/mapper/w3dm >/dev/null 2>&1 & p=\$!; sleep 5; echo '  node# blkid -p /dev/mapper/w3dm after 5 s:'; ps -o pid,stat,wchan:20,cmd -p \$p | sed 's/^/    /' )" ;;
  suspend) node "dmsetup suspend w3dm && dmsetup info w3dm | grep -E 'State|Open'" ;;
  write)   node "nohup dd if=/dev/urandom of=/w3dm/a/during-suspend bs=1M count=8 status=none >/dev/null 2>&1 & echo dd started; sleep 7; ps -eo pid,stat,wchan:22,cmd | awk '\$2 ~ /D/' | head" ;;
  resume)  node "dmsetup resume w3dm && dmsetup info w3dm | grep State; sleep 3; ps -eo pid,stat,wchan:22,etime,cmd | awk '\$2 ~ /D/' | head" ;;
  teardown)
    node "zpool destroy w3dm; dmsetup remove w3dm; for l in \$(losetup -j $IMG | cut -d: -f1); do losetup -d \$l; done; rm -f $IMG; rmdir /var/tmp/w3 2>/dev/null; rmdir /w3dm 2>/dev/null; zpool list -H -o name; losetup -a" ;;
  *) echo "usage: $0 setup|measure <label>|suspend|write|resume|teardown"; exit 2 ;;
esac
