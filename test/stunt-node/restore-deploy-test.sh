#!/usr/bin/env bash
# Restore a snapshot of the stunt VM, deploy the current build, run the suite.
#
# RESTORING DISCARDS the VM's current state: every pool image, package, config
# line and fixture made on its root disk since that snapshot. The caller says
# what becomes of that state, in words:
#
#   restore-deploy-test.sh <snapshot> --keep-current-as <name>   snapshot it first
#   restore-deploy-test.sh <snapshot> --discard-current          lose it
#
# The `baseline` snapshot holds PVE + ANAS and NO test data: after it, bring
# the fixtures back (README, "After a restore") or most specs fail on a
# missing fixture.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

usage() {
  echo "Usage: restore-deploy-test.sh <snapshot> (--keep-current-as <name> | --discard-current)" >&2
  exit 2
}

SNAPSHOT="${1:-}"; [ -n "${SNAPSHOT}" ] || usage
case "${2:-}" in
  --keep-current-as)
    [ -n "${3:-}" ] || usage
    echo "Keeping the VM's current state as snapshot '${3}'..."
    "${SCRIPT_DIR}/snapshot.sh" "$3"
    ;;
  --discard-current)
    echo "The VM's current state is discarded."
    ;;
  *) usage ;;
esac

echo "Restoring '${SNAPSHOT}' snapshot..."
"${SCRIPT_DIR}/restore.sh" "${SNAPSHOT}"
echo
echo "Deploying current ANAS build..."
"${SCRIPT_DIR}/deploy-anas.sh"
echo
"${SCRIPT_DIR}/run-tests.sh"
