#!/usr/bin/env bash
# Row 5 (cr.29) node facts — fixtures-to-be: `zfs userspace|groupspace -Hpn -o name` on
#   (1) a mounted filesystem (reference), (2) an UNMOUNTED filesystem, (3) a LOCKED
#   encrypted filesystem (passphrase key, unmounted, key unloaded), (4) a zvol —
# exact stdout, stderr and exit code, in the brief's form AND in the daemon's own argv
# (identity-ids.ts spaceArgs: `-H -p -n -o name -t posixuser -- <fs>`).
# Throwaway pool `w2id` on a 1 GiB sparse file under /var/tmp/w2.
#   r5-zfs-space-captures.sh up | capture | down
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
case "${1:-capture}" in
up)
node 'set -x; mkdir -p /var/tmp/w2 && truncate -s 1G /var/tmp/w2/w2id.img && zpool create -O mountpoint=/w2id w2id /var/tmp/w2/w2id.img
zfs create w2id/fs && install -o 51099 -g 51099 /dev/null /w2id/fs/owned-51099
zfs create w2id/unm && install -o 51098 -g 51098 /dev/null /w2id/unm/owned-51098 && zfs unmount w2id/unm
echo w2passphrase | zfs create -o encryption=on -o keyformat=passphrase -o keylocation=prompt w2id/enc && install -o 51097 -g 51097 /dev/null /w2id/enc/owned-51097
zfs unmount w2id/enc && zfs unload-key w2id/enc
zfs create -V 64M w2id/vol; set +x
zfs list -r -t all -o name,type,mounted,keystatus,canmount w2id'
;;
capture)
node 'cap() { local out err rc; out=$(mktemp -p /var/tmp/w2); err=$(mktemp -p /var/tmp/w2); "$@" >"$out" 2>"$err"; rc=$?
  echo "\$ $*"; echo "exit code: $rc"; echo "stdout ($(wc -c <"$out") bytes):"; sed "s/^/  | /" "$out"; echo "stderr ($(wc -c <"$err") bytes):"; sed "s/^/  | /" "$err"; rm -f "$out" "$err"; echo; }
zfs list -r -t all -o name,type,mounted,keystatus,canmount,mountpoint w2id; echo
for ds in w2id/fs w2id/unm w2id/enc w2id/vol; do
  echo "=================== $ds"
  cap zfs userspace -Hpn -o name $ds
  cap zfs groupspace -Hpn -o name $ds
  cap zfs userspace -H -p -n -o name -t posixuser -- $ds
  cap zfs groupspace -H -p -n -o name -t posixgroup -- $ds
done
echo "=================== the list the daemon walks (zfs list -H -o name -t filesystem), w2id rows"
zfs list -H -o name -t filesystem | grep ^w2id'
;;
down)
node 'zpool destroy w2id; rm -f /var/tmp/w2/w2id.img; rmdir /w2id 2>/dev/null; zpool list -H -o name; ls /var/tmp/w2'
;;
esac
