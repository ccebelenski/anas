#!/usr/bin/env bash
# Wave-2b node pass (docs/LIVE-PROOF-0.4.4-wave2b.md): run one probe script with the
# shared API session, output to out/<name>.log. Temp files stay inside the worktree
# (.w2btmp/, never committed), not /tmp.
# usage: run.sh <script> <logname> [args…]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
export TMPDIR="$ROOT/.w2btmp"; mkdir -p "$TMPDIR"
export API_STATE=${API_STATE:-$TMPDIR/w2b-api-session}
bash "$HERE/$1" "${@:3}" > "$HERE/out/$2.log" 2>&1
rc=$?
cat "$HERE/out/$2.log"
exit $rc
