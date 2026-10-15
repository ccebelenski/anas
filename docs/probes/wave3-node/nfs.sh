#!/usr/bin/env bash
# Wave-3 node pass: row 4 (cr.39 busy unmount without lsof), N5 (a dead hard
# NFS mount under an SMB share path) and N2b (a recursive destroy held behind a
# lock while a child dataset appears).
#
# The NFS server is the node's own kernel nfsd with a RUNTIME-only export
# (`exportfs -o … 127.0.0.1:/srv/w3nfs`, no file under /etc touched); the
# client mount is created through the ANAS API (POST /mounts, a hard NFSv4
# mount). "The server's port blocked" = one nft table `inet w3n5` dropping
# tcp/2049 on output, removed afterwards.
#
#   nfs.sh setup | busy | smb | n2b-prep | n2b-start | block | measure <label> | n2b-finish | unblock | teardown
set -uo pipefail
source "$(dirname "$0")/lib.sh"
MP=/mnt/w3nfs
MPE=%2Fmnt%2Fw3nfs
tapi() { local s out; s=$(date +%s%N); out=$(MAXTIME=45 "$API" GET "$1" 2>&1)
  printf '  GET %s -> %s in %d ms\n    %s\n' "$1" "$(http_of "$out")" "$(( ($(date +%s%N) - s) / 1000000 ))" "$(json_of "$out" | cut -c1-${2:-300})"; }
case "${1:-}" in
  setup)
    node "mkdir -p /srv/w3nfs/tree && cd /srv/w3nfs/tree && python3 -c '
import os
for i in range(60):
    os.mkdir(f\"d{i}\")
    for j in range(500): open(f\"d{i}/f{j}\",\"w\").close()
' && echo hello > /srv/w3nfs/f0 && exportfs -o rw,no_root_squash,sync,no_subtree_check,insecure 127.0.0.1:/srv/w3nfs && exportfs -v | grep w3nfs"
    r=$(api POST /mounts "{\"type\":\"nfs\",\"server\":\"127.0.0.1\",\"remotePath\":\"/srv/w3nfs\",\"mountpoint\":\"$MP\"}"); echo "$r"; wait_job "$(job_of "$r")" 60
    node "grep w3nfs /etc/fstab; findmnt $MP" ;;
  busy)
    say "row 4: is lsof / fuser installed?"
    node "command -v lsof || echo 'lsof: not installed'; command -v fuser; dpkg -S \$(command -v fuser)"
    say "row 4: hold a file open on $MP (a shell with the file on fd 3)"
    node "setsid bash -c 'exec 3<$MP/f0; exec sleep 3600' </dev/null >/dev/null 2>&1 & sleep 1; pgrep -af 'sleep 3600'; fuser -vm $MP 2>&1 | tail -3"
    say "row 4: Unmount through the API"
    r=$(api POST /mounts/$MPE/state '{"action":"unmount"}'); echo "$r"
    j=$(job_of "$r" 2>/dev/null); [ -n "$j" ] && { wait_job "$j" 60; echo "$LAST_JOB"; }
    node "findmnt $MP >/dev/null && echo 'still mounted' || echo 'NOT mounted'"
    say "row 4: Remove through the API (challenge only)"
    api DELETE "/mounts/$MPE?removeMountpointDir=false"
    node "pkill -f 'sleep 3600'; sleep 1; findmnt $MP >/dev/null && echo 'still mounted' || echo 'NOT mounted'" ;;
  smb)
    r=$(api POST /shares/smb "{\"name\":\"w3nfsshare\",\"path\":\"$MP\"}"); echo "$r"; wait_job "$(job_of "$r")" 60
    node "testparm -s 2>/dev/null | grep -A3 w3nfsshare" ;;
  n2b-prep)
    r=$(api POST /pools/w3s7/datasets '{"path":"a"}'); echo "$r"; wait_job "$(job_of "$r")" 60
    r=$(api POST /pools/w3s7/datasets '{"path":"a/b"}'); echo "$r"; wait_job "$(job_of "$r")" 60
    node "mkdir -p /w3s7/a/nfs && mount -t nfs4 -o hard,vers=4.2 127.0.0.1:/srv/w3nfs /w3s7/a/nfs && findmnt /w3s7/a/nfs; zfs list -o name -r w3s7" ;;
  n2b-start)
    say "N2b: holder — recursive ownership apply on w3s7/a (its walk enters the NFS mount at /w3s7/a/nfs)"
    confirmed PUT /pools/w3s7/datasets/a/access '{"owner":"nobody","applyToExisting":true}'
    echo "$CONFIRMED_JOB" > "$HERE/out/n2b-holder.txt" ;;
  block)
    node "nft add table inet w3n5 && nft add chain inet w3n5 out '{ type filter hook output priority 0; }' && nft add rule inet w3n5 out tcp dport 2049 drop && nft list table inet w3n5 && date -u +%T" ;;
  measure)
    say "measure: ${2:-}"
    node "( stat $MP >/dev/null 2>&1 & p=\$!; sleep 4; ps -o pid,stat,wchan:22,etime,cmd -p \$p | sed 's/^/  /' ); echo '  D/S-state on the mount:'; ps -eo pid,stat,wchan:22,etime,cmd | grep -E '[c]hown|[s]tat /mnt' | head -5"
    for p in /status /shares/smb /shares/smb/w3nfsshare /mounts /health /pools/w3s7/datasets; do tapi "$p" 260; done ;;
  n2b-finish)
    H=$(cat "$HERE/out/n2b-holder.txt"); api job "$H"
    say "N2b: recursive destroy of w3s7/a while the holder hangs"
    r=$(api DELETE "/pools/w3s7/datasets/a?recursive=true"); echo "$r"; c=$(code_of "$r")
    r=$(api DELETE "/pools/w3s7/datasets/a?recursive=true" -H "x-anas-confirm: $c"); echo "$r"; D=$(job_of "$r"); echo "$D" > "$HERE/out/n2b-destroy.txt"
    sleep 1; api job "$D"
    node "zfs create w3s7/a/d && echo 'by hand, destroy waiting: zfs create w3s7/a/d'" ;;
  unblock)
    node "nft delete table inet w3n5 && echo unblocked && date -u +%T" ;;
  n2b-result)
    H=$(cat "$HERE/out/n2b-holder.txt"); D=$(cat "$HERE/out/n2b-destroy.txt")
    wait_job "$H" 400; echo "$LAST_JOB"; wait_job "$D" 120; echo "$LAST_JOB"
    node "zfs list -o name -r w3s7" ;;
  teardown)
    node "umount /w3s7/a/nfs 2>/dev/null; rmdir /w3s7/a/nfs 2>/dev/null; true"
    WAIT_S=60 "$HERE/confirmed.sh" DELETE /shares/smb/w3nfsshare
    WAIT_S=60 "$HERE/confirmed.sh" DELETE "/mounts/$MPE?removeMountpointDir=true"
    node "exportfs -u 127.0.0.1:/srv/w3nfs; rm -rf /srv/w3nfs; exportfs -v | grep -c w3nfs; grep -c w3nfs /etc/fstab; ls -d $MP 2>&1" ;;
  *) echo "usage: see header"; exit 2 ;;
esac
