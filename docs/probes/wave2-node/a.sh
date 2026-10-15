#!/usr/bin/env bash
# Wave-2: wave 3's api.sh with the session and temp files kept inside the worktree.
#   a.sh GET /pools   |   a.sh many GET /p1 /p2 …
HERE="$(cd "$(dirname "$0")" && pwd)"
export TMPDIR="$(cd "$HERE/../../.." && pwd)/.w2tmp"; mkdir -p "$TMPDIR"
export API_STATE=${API_STATE:-$TMPDIR/w2-api-session}
if [ "${1:-}" = many ]; then m=$2; shift 2; for p in "$@"; do echo "== $m $p"; "$HERE/../wave3-node/api.sh" "$m" "$p" 2>&1 | cut -c1-${CUT:-800}; done; exit; fi
exec "$HERE/../wave3-node/api.sh" "$@"
