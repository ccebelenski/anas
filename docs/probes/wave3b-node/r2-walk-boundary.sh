#!/usr/bin/env bash
# Wave-3b row 2 (nf.1 D2): a recursive permission apply on a throwaway dataset
# with a live NFS mount below it. Pool w3r2 on a sparse FILE vdev
# (/var/tmp/w3r/w3r2.img); datasets w3r2/a and w3r2/a/b through the API; the
# NFS server is the node's own nfsd with a runtime-only export
# 127.0.0.1:/srv/w3r-nfs (no file under /etc touched), mounted by hand at
# /w3r2/a/nfs (hard, NFSv4.2). "Blocked" = nft table `inet w3r2` dropping
# tcp/2049 on output.
#
#   r2-walk-boundary.sh setup | snap <label> | apply | block | apply-blocked | unblock | teardown
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
case "${1:-}" in
  setup)
    node "mkdir -p /var/tmp/w3r && truncate -s 1G /var/tmp/w3r/w3r2.img && zpool create -O mountpoint=/w3r2 w3r2 /var/tmp/w3r/w3r2.img && zpool list -H -o name,health w3r2"
    for d in a a/b; do r=$(api POST /pools/w3r2/datasets "{\"path\":\"$d\"}"); echo "$r"; wait_job "$(job_of "$r")" 60; done
    # Files AFTER every zfs create: OpenZFS's zfs.exports runs exportfs -ra on a
    # dataset mount and drops runtime-only exports (wave-3 N5 node fact).
    node "mkdir -p /w3r2/a/sub && touch /w3r2/a/f1 /w3r2/a/sub/f2 /w3r2/a/b/f3 && mkdir -p /srv/w3r-nfs/tree && cd /srv/w3r-nfs/tree && for i in \$(seq 0 9); do mkdir d\$i; for j in \$(seq 0 49); do : > d\$i/f\$j; done; done; echo hi > /srv/w3r-nfs/top && exportfs -o rw,no_root_squash,sync,no_subtree_check,insecure 127.0.0.1:/srv/w3r-nfs && exportfs -v | grep w3r && mkdir -p /w3r2/a/nfs && mount -t nfs4 -o hard,vers=4.2 127.0.0.1:/srv/w3r-nfs /w3r2/a/nfs && findmnt -R /w3r2 -o TARGET,SOURCE,FSTYPE" ;;
  snap)
    say "ownership snapshot: ${2:-}"
    node "echo '  server side /srv/w3r-nfs:'; find /srv/w3r-nfs -printf '%u:%g %m %p\n' | sort > /tmp/w3r2-srv-${2:-x}.txt; awk '{print \$1, \$2}' /tmp/w3r2-srv-${2:-x}.txt | sort | uniq -c | sed 's/^/    /'; echo \"    files: \$(wc -l < /tmp/w3r2-srv-${2:-x}.txt)  sha256 of the listing: \$(sha256sum < /tmp/w3r2-srv-${2:-x}.txt | cut -c1-16)\"; echo '  dataset side:'; for f in /w3r2/a /w3r2/a/f1 /w3r2/a/sub /w3r2/a/sub/f2 /w3r2/a/b /w3r2/a/b/f3 /w3r2/a/nfs /w3r2/a/nfs/top; do printf '    %-22s %s\n' \$f \"\$(timeout 3 stat -c '%U:%G %a' \$f 2>&1)\"; done" ;;
  apply)
    say "recursive owner apply on w3r2/a (NFS live): challenge, resend"
    confirmed PUT /pools/w3r2/datasets/a/access '{"owner":"nobody","applyToExisting":true}'
    if [ -n "${CONFIRMED_JOB:-}" ]; then wait_job "$CONFIRMED_JOB" 120; echo "$LAST_JOB"; fi ;;
  block)
    node "nft add table inet w3r2 && nft add chain inet w3r2 out '{ type filter hook output priority 0; }' && nft add rule inet w3r2 out tcp dport 2049 drop && nft list table inet w3r2 && date -u +%T"
    node "( timeout 3 stat -f /w3r2/a/nfs >/dev/null 2>&1; echo \"  timeout 3 stat -f /w3r2/a/nfs -> exit \$?\" )" ;;
  apply-blocked)
    say "recursive owner apply (owner daemon) with the NFS server blocked: challenge, resend"
    s=$(date +%s%N)
    confirmed PUT /pools/w3r2/datasets/a/access '{"owner":"daemon","applyToExisting":true}'
    echo "  (challenge + resend took $(( ($(date +%s%N) - s) / 1000000 )) ms)"
    if [ -n "${CONFIRMED_JOB:-}" ]; then wait_job "$CONFIRMED_JOB" 120; echo "$LAST_JOB"; fi
    node "ps -eo pid,stat,wchan:22,etime,cmd | grep -E '[f]ind -P|[c]hown' | head -5; echo '  (no find/chown left above = none hung)'" ;;
  confirm-live-then-block)
    say "challenge while live (owner nobody), block, then resend the code"
    r1=$(api PUT /pools/w3r2/datasets/a/access '{"owner":"nobody","applyToExisting":true}'); echo "$r1"; c=$(code_of "$r1")
    bash "$0" block
    r2=$(api PUT /pools/w3r2/datasets/a/access '{"owner":"nobody","applyToExisting":true}' -H "x-anas-confirm: $c"); echo "$r2"
    j=$(job_of "$r2" 2>/dev/null); if [ -n "$j" ]; then wait_job "$j" 120; echo "$LAST_JOB"; fi ;;
  unblock)
    node "nft delete table inet w3r2 && echo unblocked && date -u +%T" ;;
  teardown)
    node "nft delete table inet w3r2 2>/dev/null; umount /w3r2/a/nfs || umount -f -l /w3r2/a/nfs; exportfs -u 127.0.0.1:/srv/w3r-nfs; rm -rf /srv/w3r-nfs /tmp/w3r2-srv-*.txt; zpool destroy w3r2 && rm -f /var/tmp/w3r/w3r2.img; rmdir /w3r2 2>/dev/null; exportfs -v | grep -c w3r; zpool list -H -o name | grep -c w3r; findmnt -t nfs,nfs4" ;;
  *) echo "usage: see header"; exit 2 ;;
esac
