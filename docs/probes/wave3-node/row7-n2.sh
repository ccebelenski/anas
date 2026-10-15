#!/usr/bin/env bash
# Wave-3 node pass, row 7 (cr.36/37 smoke) + N2 (WAVE3-DESIGN §8.3).
# Throwaway pool w3s7 on hot disk 21 (attached by the record's setup), datasets
# w3s7/a, w3s7/a/b; everything through the API except the "by hand" steps the
# rows call for (a child dataset appearing, a bookmark, the file tree).
#
#   7c  rollback with force names the snapshots (and the bookmark) it destroys;
#       a resend with the other `force` is CONFIRM_SCOPE_CHANGED naming it
#   N2a recursive destroy: a child created between challenge and resend → 409
#       CONFIRM_SCOPE_CHANGED naming it (a fresh code)
#   N2b the same with the job held behind a lock (a recursive ownership apply
#       on w3s7/a holds zfs:<guid>/a EXCLUSIVE): a child created while the
#       destroy waits → the job fails STATE_CHANGED, nothing destroyed
set -uo pipefail
source "$(dirname "$0")/lib.sh"
DISK=scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT21
P=w3s7

say "setup: pool $P, datasets a, a/b"
r=$(api POST /pools "{\"name\":\"$P\",\"dataVdevs\":[{\"type\":\"stripe\",\"disks\":[\"$DISK\"]}]}"); echo "$r"; wait_job "$(job_of "$r")" 60
for d in a a/b; do r=$(api POST /pools/$P/datasets "{\"path\":\"$d\"}"); echo "$r"; wait_job "$(job_of "$r")" 60; done

say "7c: snapshots s1 s2 s3 of $P/a (API), bookmark #bm3 (by hand)"
for s in s1 s2 s3; do r=$(api POST /pools/$P/datasets/a/snapshots "{\"name\":\"$s\"}"); echo "$r"; wait_job "$(job_of "$r")" 60; done
node "zfs bookmark $P/a@s3 $P/a#bm3; zfs list -t all -o name -r $P/a"
say "7c: rollback to s1 WITHOUT force (challenge)"
api POST "/pools/$P/datasets/a/snapshots/s1/rollback"
say "7c: rollback to s1 WITH force (challenge)"
r=$(api POST "/pools/$P/datasets/a/snapshots/s1/rollback?force=true"); echo "$r"; c=$(code_of "$r")
say "7c: resend the force=true code on force=false → CONFIRM_SCOPE_CHANGED"
api POST "/pools/$P/datasets/a/snapshots/s1/rollback?force=false" -H "x-anas-confirm: $c"
say "7c: fresh force=true challenge, resend with its code"
r=$(api POST "/pools/$P/datasets/a/snapshots/s1/rollback?force=true"); echo "$r"; c=$(code_of "$r")
r=$(api POST "/pools/$P/datasets/a/snapshots/s1/rollback?force=true" -H "x-anas-confirm: $c"); echo "$r"; wait_job "$(job_of "$r")" 60
node "zfs list -t all -o name -r $P/a"

say "N2a: recursive destroy of $P/a — challenge"
r=$(api DELETE "/pools/$P/datasets/a?recursive=true"); echo "$r"; c1=$(code_of "$r")
node "zfs create $P/a/c && echo 'by hand: zfs create $P/a/c'"
say "N2a: resend the first code after the child appeared"
r=$(api DELETE "/pools/$P/datasets/a?recursive=true" -H "x-anas-confirm: $c1"); echo "$r"
node "zfs list -o name -r $P/a"

say "N2b: a large tree under $P/a/files (by hand), for the lock holder"
node "mkdir -p /$P/a/files && cd /$P/a/files && python3 -c '
import os
for i in range(400):
    d=f\"d{i:03d}\"; os.mkdir(d)
    for j in range(500): open(f\"{d}/f{j}\",\"w\").close()
' && find /$P/a/files -type f | wc -l"
say "N2b: holder — PUT access owner=nobody applyToExisting on $P/a (X on its key)"
confirmed PUT /pools/$P/datasets/a/access '{"owner":"nobody","applyToExisting":true}'
HOLDER=$CONFIRMED_JOB; echo "holder job $HOLDER"
api job "$HOLDER"
say "N2b: recursive destroy challenged + confirmed while the holder runs"
r=$(api DELETE "/pools/$P/datasets/a?recursive=true"); echo "$r"; c=$(code_of "$r")
r=$(api DELETE "/pools/$P/datasets/a?recursive=true" -H "x-anas-confirm: $c"); echo "$r"; D=$(job_of "$r")
sleep 1; api job "$D"; api job "$HOLDER"
node "zfs create $P/a/d && echo 'by hand (destroy waiting): zfs create $P/a/d'"
say "N2b: the holder ends, then the destroy runs"
wait_job "$HOLDER" 600; echo "$LAST_JOB"
wait_job "$D" 120; echo "$LAST_JOB"
node "zfs list -o name -r $P/a"
