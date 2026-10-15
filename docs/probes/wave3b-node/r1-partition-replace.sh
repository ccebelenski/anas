#!/usr/bin/env bash
# Wave-3b row 1 (nf.1 D1): replace a by-id -part2 (log) by a -part4 (the freed
# spare) through the API, on `vdev-fixture.sh up-byid` (pool gtvdev, hot9).
# Captures `blkid -p` for a zfs_member partition and a blank one, with exits.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
ID=scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9
P=/dev/disk/by-id/$ID

say "zpool status (before)"
node "zpool status gtvdev"

say "blkid -p on a zfs_member partition (part1, the data leaf), exit code"
node "blkid -p $P-part1; echo exit=\$?"

say "free the spare: zpool remove gtvdev $ID-part4 (by hand, as in the D1 repro)"
node "zpool remove gtvdev $ID-part4; echo exit=\$?"
say "blkid -p on part4 after the remove (label kept?), exit code"
node "blkid -p $P-part4; echo exit=\$?"

say "attach/replace onto part4 WITH its label still there -> expect a signature refusal"
api POST /pools/gtvdev/attach "{\"existingDiskId\":\"$ID-part2\",\"newDiskId\":\"$ID-part4\",\"replace\":true}"

say "zpool labelclear -f part4; then blkid -p (the blank partition), exit code"
node "zpool labelclear -f $P-part4; echo labelclear-exit=\$?; blkid -p $P-part4; echo exit=\$?; wipefs -n $P-part4; echo wipefs-exit=\$?"

say "replace part2 by part4 (challenge, resend)"
confirmed POST /pools/gtvdev/attach "{\"existingDiskId\":\"$ID-part2\",\"newDiskId\":\"$ID-part4\",\"replace\":true}"
if [ -n "${CONFIRMED_JOB:-}" ]; then
  say "job $CONFIRMED_JOB"
  wait_job "$CONFIRMED_JOB" 180
  echo "$LAST_JOB"
fi

say "zpool status (after)"
node "zpool status gtvdev"
say "blkid -p on the replaced-away part2, exit code"
node "blkid -p $P-part2; echo exit=\$?"

say "the stripped (whole-disk) id as newDiskId -> the ambiguity / whole-disk gate"
api POST /pools/gtvdev/attach "{\"existingDiskId\":\"$ID-part4\",\"newDiskId\":\"$ID\",\"replace\":true}"
say "a partition that does not exist -> 400 not found"
api POST /pools/gtvdev/attach "{\"existingDiskId\":\"$ID-part4\",\"newDiskId\":\"$ID-part9\",\"replace\":true}"
