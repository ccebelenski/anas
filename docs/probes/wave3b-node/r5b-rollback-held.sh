#!/usr/bin/env bash
# Wave-3b row 5b: after r5-mover-claims.sh run — confirm the rollback again (the
# re-gate's "confirm again"), with the replication's held snapshot among the
# ones force destroys.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
node "zfs holds -r w3r5s/src 2>&1"
confirmed POST '/pools/w3r5s/datasets/src/snapshots/s0/rollback?force=true'
if [ -n "${CONFIRMED_JOB:-}" ]; then wait_job "$CONFIRMED_JOB" 120; echo "$LAST_JOB"; fi
node "zfs list -t all -o name -r w3r5s; zfs holds -r w3r5s/src 2>&1"
