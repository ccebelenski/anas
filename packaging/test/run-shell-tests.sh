#!/usr/bin/env bash
set -euo pipefail

# Run shell tests for ANAS packaging and pve-integration
# Each test is run with stdin closed to avoid hangs.

# Every shell suite in the two test directories, found by glob so a new
# *.test.sh can never be left out of `npm test` and CI (ruling (k)).
shopt -s nullglob
TESTS=(packaging/test/*.test.sh packages/pve-integration/test/*.test.sh)
if [ "${#TESTS[@]}" -eq 0 ]; then
  echo "run-shell-tests: no *.test.sh found (run from the repo root)" >&2
  exit 1
fi

FAIL=0
for f in "${TESTS[@]}"; do
  echo "=== Running $f ==="
  if bash "$f" </dev/null; then
    echo "$f: PASS"
  else
    echo "$f: FAIL"
    FAIL=1
  fi
  echo
done

exit $FAIL
