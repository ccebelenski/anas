#!/usr/bin/env bash
# Row 4 re-runs: the specs re-cut in this pass (one-line (a) fixes) plus cloud-tasks-ui (unchanged,
# to see whether its failure reproduces), three times — run2, run3, run4 — with the leak sweep
# (r4-leaks.sh) after each round.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SPECS="cloud-guided-viewer.spec.ts cloud-remotes-ui.spec.ts cloud-review-fixes.spec.ts identity-passdb.spec.ts schedules-exclude-api.spec.ts cloud-tasks-ui.spec.ts"
for t in run2 run3 run4; do
  "$HERE/r4-specs.sh" "$t" $SPECS
  "$HERE/run.sh" r4-leaks.sh "r4-leaks-after-$t" > /dev/null 2>&1
done
