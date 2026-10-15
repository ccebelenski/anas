#!/usr/bin/env bash
# Wave-3b: run one probe script with the shared API session, output to out/<name>.log
# usage: run.sh <script> <logname>
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export API_STATE=${API_STATE:-/tmp/claude-1000/w3r-api-session}
bash "$HERE/$1" "${@:3}" > "$HERE/out/$2.log" 2>&1
rc=$?
cat "$HERE/out/$2.log"
exit $rc
