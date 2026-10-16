#!/usr/bin/env bash
# Row 4, second re-run set (after the D13 one-line panel fix was deployed and identity-passdb's
# second stale expectation was re-cut): cloud-tasks-ui and identity-passdb, three times each.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
for t in d13-1 d13-2 d13-3; do
  "$HERE/r4-specs.sh" "$t" cloud-tasks-ui.spec.ts identity-passdb.spec.ts
  "$HERE/run.sh" r4-leaks.sh "r4-leaks-after-$t" > /dev/null 2>&1
done
