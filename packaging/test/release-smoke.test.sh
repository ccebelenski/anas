#!/usr/bin/env bash
#
# cr3.core CORE-L10: make-release.sh's smoke test must not start the real
# daemon. A real boot runs the AHR boot scan, the iSCSI quarantine and the
# self-heal reconcile; on a build host that is a PVE node (as root) they act on
# the node beside its live anasd. The smoke now imports what dist/index.js
# imports (module resolution over the whole graph) and starts nothing.
#
#   bash packaging/test/release-smoke.test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
RELEASE="${HERE}/../make-release.sh"

PASS=0
FAIL=0
ok()   { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
check(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

echo "== the release smoke never starts the daemon =="
check "no command line runs the daemon's dist/index.js" \
  "! grep -vE '^[[:space:]]*#' '${RELEASE}' | grep -qE 'node[^|]*daemon/dist/index\.js'"
check "the daemon smoke imports the entry's own imports" "grep -q 'DAEMON_IMPORTS' '${RELEASE}'"

echo "== the import check itself, run against this tree's built daemon (when built) =="
DIST="${REPO}/packages/daemon/dist"
if [ -f "${DIST}/index.js" ]; then
  # The block between the two markers, run with APP pointing at the repo
  # (the release lays out app/packages/daemon/dist the same way).
  WORK="$(mktemp -d -p "${ANAS_TEST_TMPDIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}" .scratch.XXXXXX)"
  trap 'rm -rf "${WORK}"' EXIT
  sed -n '/^# Daemon: every module its entry point imports must load/,/^# Gateway: boots and listens/p' "${RELEASE}" > "${WORK}/block.sh"
  run_block() {
    ( APP="$1"; smoke_fail=0
      log() { echo "LOG $*"; }; err() { echo "ERR $*"; }
      # shellcheck disable=SC1091
      source "${WORK}/block.sh"
      echo "smoke_fail=${smoke_fail}" ) > "${WORK}/out.log" 2>&1
  }
  run_block "${REPO}"
  check "the real graph loads (smoke_fail=0)" "grep -qx 'smoke_fail=0' '${WORK}/out.log'"
  check "it says the daemon was not started" "grep -q 'the daemon was not started' '${WORK}/out.log'"
  # A broken graph: an entry import that does not resolve fails the smoke.
  mkdir -p "${WORK}/broken/packages/daemon/dist"
  printf "import { x } from './no-such-module.js'\n" > "${WORK}/broken/packages/daemon/dist/index.js"
  run_block "${WORK}/broken"
  check "a missing module fails the smoke (smoke_fail=1)" "grep -qx 'smoke_fail=1' '${WORK}/out.log'"
  # cr3 review: a side-effect import (`import './x.js'`) is part of the graph.
  mkdir -p "${WORK}/side/packages/daemon/dist"
  printf "export const ok = 1\n" > "${WORK}/side/packages/daemon/dist/fine.js"
  printf "import { ok } from './fine.js'\nimport './no-such-side-effect.js'\nconsole.log(ok)\n" > "${WORK}/side/packages/daemon/dist/index.js"
  run_block "${WORK}/side"
  check "a missing side-effect import fails the smoke" "grep -qx 'smoke_fail=1' '${WORK}/out.log' && grep -q 'no-such-side-effect' '${WORK}/out.log'"
  # cr3 review: index.js's own syntax is checked (nothing else parses it).
  mkdir -p "${WORK}/syntax/packages/daemon/dist"
  printf "export const ok = 1\n" > "${WORK}/syntax/packages/daemon/dist/fine.js"
  printf "import { ok } from './fine.js'\nconst x = ;\n" > "${WORK}/syntax/packages/daemon/dist/index.js"
  run_block "${WORK}/syntax"
  check "an index.js that does not parse fails the smoke" "grep -qx 'smoke_fail=1' '${WORK}/out.log' && grep -q 'does not parse' '${WORK}/out.log'"
else
  echo "  skip packages/daemon/dist not built (the static checks above stand)"
fi

echo
echo "release-smoke tests: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
