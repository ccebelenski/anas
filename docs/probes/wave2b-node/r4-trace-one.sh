#!/usr/bin/env bash
# Row 4: run ONE test of one spec with a Playwright trace (network + DOM snapshots), to classify a
# failure from what the page actually requested and when.
#   usage: r4-trace-one.sh <spec.ts> <grep> <logname>
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"
export TMPDIR="$ROOT/.w2btmp" ANAS_REQUIRE_FIXTURES=1
rm -rf test-results
timeout 900 npx playwright test --project=integration "tests/integration/$1" -g "$2" --trace on --reporter=list > "$HERE/out/r4/$3.log" 2>&1
echo "rc=$?"; tail -4 "$HERE/out/r4/$3.log"; find test-results -name 'trace.zip'
