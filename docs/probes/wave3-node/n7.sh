#!/usr/bin/env bash
# Wave-3 node pass, N7 (cr.45) — the node side of n7-polljob.spec.ts.
#
# Pool w3n7 (hot disk 20), dataset w3n7/big. The lock HOLDER is a recursive
# ownership apply on w3n7/big whose walk enters a hard NFS mount at
# /w3n7/big/nfs while the NFS port is dropped (nft table inet w3n5): `chown -R`
# sleeps killable in rpc_wait, the job holds `zpool:<guid>` shared, and the UI
# Export (exclusive) queues behind it. A killable sleep matters: stopping anasd
# must be able to end the holder (a D-state holder would wedge the stop).
#
#   n7.sh setup | arm | holder | release | reimport | teardown
set -uo pipefail
source "$(dirname "$0")/lib.sh"
case "${1:-}" in
  setup)
    r=$(api POST /pools '{"name":"w3n7","dataVdevs":[{"type":"stripe","disks":["scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT20"]}]}'); echo "$r"; wait_job "$(job_of "$r")" 60
    r=$(api POST /pools/w3n7/datasets '{"path":"big"}'); echo "$r"; wait_job "$(job_of "$r")" 60
    node "mkdir -p /srv/w3nfs/tree && cd /srv/w3nfs/tree && python3 -c '
import os
for i in range(20):
    os.makedirs(f\"d{i}\", exist_ok=True)
    for j in range(200): open(f\"d{i}/f{j}\",\"w\").close()
'; mkdir -p /w3n7/big/nfs; echo set-up" ;;
  arm)  # (re)export, mount by hand, drop the port
    node "exportfs -v | grep -q w3nfs || exportfs -o rw,no_root_squash,sync,no_subtree_check,insecure 127.0.0.1:/srv/w3nfs
      findmnt /w3n7/big/nfs >/dev/null || mount -t nfs4 -o hard,vers=4.2 127.0.0.1:/srv/w3nfs /w3n7/big/nfs
      ls /w3n7/big/nfs >/dev/null && nft list table inet w3n5 >/dev/null 2>&1 || { nft add table inet w3n5 && nft add chain inet w3n5 out '{ type filter hook output priority 0; }' && nft add rule inet w3n5 out tcp dport 2049 drop; }
      findmnt -n -o TARGET,SOURCE /w3n7/big/nfs; nft list ruleset | grep -c 'dport 2049 drop'" ;;
  holder)
    confirmed PUT /pools/w3n7/datasets/big/access "{\"owner\":\"${2:-nobody}\",\"applyToExisting\":true}" >/dev/null
    sleep 2; api job "$CONFIRMED_JOB" | tail -1 | cut -c1-200 ;;
  release)  # detach the NFS mount lazily, then reopen the port: the holder finishes
    node "umount -l /w3n7/big/nfs; exportfs -v | grep -q w3nfs || exportfs -o rw,no_root_squash,sync,no_subtree_check,insecure 127.0.0.1:/srv/w3nfs; nft delete table inet w3n5 2>/dev/null; echo released" ;;
  reimport)
    node "zpool import w3n7 2>&1; zpool list -H -o name w3n7" ;;
  teardown)
    node "nft delete table inet w3n5 2>/dev/null; umount -l /w3n7/big/nfs 2>/dev/null; rmdir /w3n7/big/nfs 2>/dev/null; exportfs -u 127.0.0.1:/srv/w3nfs 2>/dev/null; rm -rf /srv/w3nfs; true"
    WAIT_S=60 "$HERE/confirmed.sh" DELETE '/pools/w3n7?cleanup=true' | tail -1 | cut -c1-300 ;;
  *) echo "usage: see header"; exit 2 ;;
esac
