#!/usr/bin/env bash
# Wave-3b row 3 (nf.2 D3): this node has fuser and no lsof. A throwaway NFS mount
# /mnt/w3r3 (POST /mounts, server = the node's own nfsd, runtime export
# 127.0.0.1:/srv/w3r-nfs from r2-walk-boundary.sh setup), a holder with a file
# open on it, Unmount through the API.
#
#   r3-busy-unmount.sh setup | busy | newholder | teardown
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
MP=/mnt/w3r3
MPE=%2Fmnt%2Fw3r3
hold() { # $1 = tag; a shell holding $MP/top open on fd 3, then sleeping
  node "setsid bash -c 'exec 3<$MP/top; exec -a w3r3-$1 sleep 3600' </dev/null >/dev/null 2>&1 & sleep 1; pgrep -a -x -f 'w3r3-$1 3600'"
}
case "${1:-}" in
  setup)
    node "command -v lsof || echo 'lsof: not installed'; command -v fuser; dpkg -S \$(command -v fuser)"
    node "exportfs -v | grep -q w3r-nfs || exportfs -o rw,no_root_squash,sync,no_subtree_check,insecure 127.0.0.1:/srv/w3r-nfs; exportfs -v | grep w3r"
    r=$(api POST /mounts "{\"type\":\"nfs\",\"server\":\"127.0.0.1\",\"remotePath\":\"/srv/w3r-nfs\",\"mountpoint\":\"$MP\"}"); echo "$r"; wait_job "$(job_of "$r")" 60
    node "grep w3r3 /etc/fstab; findmnt $MP" ;;
  busy)
    say "a holder: fd 3 on $MP/top"
    hold a
    node "echo '  fuser -vm $MP:'; fuser -vm $MP 2>&1 | sed 's/^/    /'; echo '  a non-holder for comparison:'; setsid bash -c 'exec -a w3r3-bystander sleep 3600' </dev/null >/dev/null 2>&1 & sleep 0.5; pgrep -a -x -f 'w3r3-bystander 3600'"
    say "Unmount through the API: challenge"
    r1=$(api POST /mounts/$MPE/state '{"action":"unmount"}'); echo "$r1"; c=$(code_of "$r1")
    if [ -n "$c" ]; then
      say "resend with the code (the forced lazy unmount)"
      r2=$(api POST /mounts/$MPE/state '{"action":"unmount"}' -H "x-anas-confirm: $c"); echo "$r2"
      j=$(job_of "$r2" 2>/dev/null); if [ -n "$j" ]; then wait_job "$j" 60; echo "$LAST_JOB"; fi
    else
      j=$(job_of "$r1" 2>/dev/null); if [ -n "$j" ]; then wait_job "$j" 60; echo "$LAST_JOB"; fi
    fi
    say "after: the mount, the holder, the bystander"
    node "findmnt $MP >/dev/null && echo '  $MP still mounted' || echo '  $MP NOT mounted (detached)'; for t in a bystander; do p=\$(pgrep -x -f \"w3r3-\$t 3600\"); echo \"  w3r3-\$t pid \$p alive: \$( [ -n \"\$p\" ] && kill -0 \$p && echo yes || echo no ) fd3: \$(readlink /proc/\$p/fd/3 2>&1)\"; done; echo \"  holder reads its fd: \$(cat /proc/\$(pgrep -x -f 'w3r3-a 3600')/fd/3 2>&1)\"; grep -c w3r3 /etc/fstab | sed 's/^/  fstab lines for w3r3: /'"
    node "pkill -x -f 'w3r3-[a-z]* 3600'; sleep 1; pgrep -a -x -f 'w3r3-[a-z]* 3600' || echo '  holders gone'" ;;
  newholder)
    say "mount again, one holder, challenge; a SECOND holder opens before the resend"
    r=$(api POST /mounts/$MPE/state '{"action":"mount"}'); echo "$r"; j=$(job_of "$r" 2>/dev/null); [ -n "$j" ] && wait_job "$j" 60
    hold b
    r1=$(api POST /mounts/$MPE/state '{"action":"unmount"}'); echo "$r1"; c=$(code_of "$r1")
    hold c
    r2=$(api POST /mounts/$MPE/state '{"action":"unmount"}' -H "x-anas-confirm: $c"); echo "$r2"
    j=$(job_of "$r2" 2>/dev/null); if [ -n "$j" ]; then wait_job "$j" 60; echo "$LAST_JOB"; fi
    node "findmnt $MP >/dev/null && echo '  $MP still mounted' || echo '  $MP NOT mounted'; pkill -x -f 'w3r3-[a-z]* 3600'; sleep 1; pgrep -a -x -f 'w3r3-[a-z]* 3600' || echo '  holders gone'" ;;
  samesb)
    say "the same NFS export is ALSO mounted at /w3r2/a/nfs (row 2): a holder there only, then challenge Unmount of $MP"
    r=$(api POST /mounts/$MPE/state '{"action":"mount"}'); echo "$r"; j=$(job_of "$r" 2>/dev/null); [ -n "$j" ] && wait_job "$j" 60
    node "setsid bash -c 'exec 3</w3r2/a/nfs/top; exec -a w3r3-other sleep 3600' </dev/null >/dev/null 2>&1 & sleep 1; pgrep -a -x -f 'w3r3-other 3600'; echo '  fuser -vm $MP:'; fuser -vm $MP 2>&1 | sed 's/^/    /'; echo '  stat -c %d of both mountpoints:'; stat -c '    %n dev %d' $MP /w3r2/a/nfs"
    api POST /mounts/$MPE/state '{"action":"unmount"}'
    node "pkill -x -f 'w3r3-[a-z]* 3600'; sleep 1; pgrep -a -x -f 'w3r3-[a-z]* 3600' || echo '  holders gone'" ;;
  teardown)
    node "pkill -x -f 'w3r3-[a-z]* 3600'; true"
    WAIT_S=60 "$(dirname "$0")/../wave3-node/confirmed.sh" DELETE "/mounts/$MPE?removeMountpointDir=true"
    node "grep -c w3r3 /etc/fstab; ls -d $MP 2>&1; findmnt $MP || echo '  not mounted'" ;;
  *) echo "usage: see header"; exit 2 ;;
esac
