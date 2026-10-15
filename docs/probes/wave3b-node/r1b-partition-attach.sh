#!/usr/bin/env bash
# Wave-3b row 1b: the stripped (whole-disk) id as existingDiskId, and an ATTACH
# (mirror) of a free partition onto the data leaf — after r1-partition-replace.sh.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
ID=scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9
say "replace with existingDiskId = the stripped id (six leaves share it) -> ambiguity refusal"
api POST /pools/gtvdev/attach "{\"existingDiskId\":\"$ID\",\"newDiskId\":\"$ID-part2\",\"replace\":true}"
say "attach (mirror) the blank -part2 onto the data leaf -part1"
confirmed POST /pools/gtvdev/attach "{\"existingDiskId\":\"$ID-part1\",\"newDiskId\":\"$ID-part2\"}"
if [ -n "${CONFIRMED_JOB:-}" ]; then wait_job "$CONFIRMED_JOB" 180; echo "$LAST_JOB"; fi
node "zpool status gtvdev | sed -n '/config:/,/errors/p'"
