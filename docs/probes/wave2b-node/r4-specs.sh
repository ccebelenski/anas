#!/usr/bin/env bash
# Row 4: integration specs run ONE AT A TIME from this worktree against the deployed node
# (`npx playwright test --project=integration tests/integration/<spec> --reporter=list`), with
# ANAS_REQUIRE_FIXTURES=1 so a missing fixture fails loudly instead of skipping. Each spec's output
# goes to out/r4/<spec>-<tag>.log; one summary line per spec to out/r4/summary-<tag>.txt.
#   usage: r4-specs.sh <tag> [spec.ts ...]    (no specs = every spec but the five the brief blocks)
# Blocked (never run here): smbsvc-api, ahr-cache-review (the brief: mdadm.conf names ahrpv, gtcache);
# ahr-cache-api, ahr-cache-ui (create AHR pool `gtcache`, a name the brief forbids);
# ahr-expand-zero-gain (creates AHR pool `gtexpand` through ANAS, whose create pins the arrays in
# /etc/mdadm/mdadm.conf — an edit of the file the brief says never to edit).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
TAG=${1:?tag}; shift
OUT="$HERE/out/r4"; mkdir -p "$OUT"
export TMPDIR="$ROOT/.w2btmp"; mkdir -p "$TMPDIR"
export ANAS_REQUIRE_FIXTURES=1
BLOCKED="smbsvc-api.spec.ts ahr-cache-review.spec.ts ahr-cache-api.spec.ts ahr-cache-ui.spec.ts ahr-expand-zero-gain.spec.ts"
if [ $# -gt 0 ]; then SPECS="$*"; else SPECS=$(cd "$ROOT/tests/integration" && ls *.spec.ts); fi
cd "$ROOT"
for s in $SPECS; do
  case " $BLOCKED " in *" $s "*) echo "$s BLOCKED" >> "$OUT/summary-$TAG.txt"; continue ;; esac
  t0=$(date +%s)
  timeout 2400 npx playwright test --project=integration "tests/integration/$s" --reporter=list > "$OUT/${s%.spec.ts}-$TAG.log" 2>&1
  rc=$?
  tail_line=$(grep -E '^\s+[0-9]+ (passed|failed|skipped|flaky|did not run)' "$OUT/${s%.spec.ts}-$TAG.log" | tr -s ' ' | tr '\n' ';')
  echo "$s rc=$rc $(( $(date +%s) - t0 ))s $tail_line" | tee -a "$OUT/summary-$TAG.txt"
done
