#!/usr/bin/env bash
#
# Tests for packaging/install.sh's Node.js floor (MIN_NODE_MAJOR). The floor is
# a floor: a newer Node already on the node — another product's install, a
# NodeSource major ahead of the one ANAS's own --install-deps provides — passes
# preflight and is used as it stands, never reinstalled (ruling 2026-10-18,
# EPICS §2 "UI & packaging": the floor stays 20 through 0.4.x; the next major
# release raises it).
#
# install.sh is sourced in ANAS_INSTALL_LIB_ONLY mode so ONLY phase0_preflight
# runs — read-only by design — with NODE_BIN pointed at a fake `node` that
# prints the version under test and ss/systemctl faked. Nothing here can
# install anything, even when run as root on a real PVE node. The other
# preflight items (PVE, ZFS, the release layout) report whatever this box has;
# only the Node.js lines are asserted.
#
# Covers:
#   1. the floor itself (v20.0.0) passes.
#   2. the Node the installer provides (v22.x) passes.
#   3. a Node ahead of it (v24.x, v26.x) passes, and with --install-deps is
#      NOT marked for (re)installation.
#   4. below the floor (v18.x): refused with the floor and the fix; with
#      --install-deps, marked for installation instead.
#   5. no node at all: refused; with --install-deps, marked for installation.
#   6. a `node --version` that fails is read as too old, never as OK
#      (a read that could not see never says safe).
#
#   bash packaging/test/node-floor.test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "${HERE}/.." && pwd)"

PASS=0
FAIL=0
ok()   { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# Fakes: ss reports nothing listening; systemctl says nothing is active.
cat > "${WORK}/ss" <<'EOS'
#!/usr/bin/env bash
exit 0
EOS
cat > "${WORK}/systemctl" <<'EOS'
#!/usr/bin/env bash
exit 3
EOS
chmod +x "${WORK}/ss" "${WORK}/systemctl"

# A fake `node` whose --version prints $1 (e.g. v24.14.0). An empty $1 makes
# it fail like a broken binary: no output, exit 1.
fake_node() {
  local ver="$1" bin="${WORK}/node-${1:-broken}"
  if [ -n "${ver}" ]; then
    printf '#!/usr/bin/env bash\nprintf "%%s\\n" "%s"\n' "${ver}" > "${bin}"
  else
    printf '#!/usr/bin/env bash\nexit 1\n' > "${bin}"
  fi
  chmod +x "${bin}"
  printf '%s' "${bin}"
}

# Run ONLY the read-only preflight with NODE_BIN=$1; $2 = 1 sets --install-deps.
# Output -> $LOG. The exit status is not asserted: on a non-PVE box the PVE
# check is a FATAL of its own, so only the Node.js lines carry the verdict.
preflight() {
  local node_bin="$1" deps_flag=""
  [ "${2:-0}" = "1" ] && deps_flag="--install-deps"   # parsed by install.sh's own argv loop
  LOG="${WORK}/preflight.log"
  ANAS_INSTALL_LIB_ONLY=1 \
  PREFIX="${WORK}/opt-anas" \
  ANAS_ENV_FILE="${WORK}/etc-default-anas" \
  NODE_BIN="${node_bin}" \
  SS_BIN="${WORK}/ss" SYSTEMCTL_BIN="${WORK}/systemctl" \
    bash -c 'source "$0" "$@"; phase0_preflight' \
      "${PKG}/install.sh" ${deps_flag} >"${LOG}" 2>&1
}

node_ok()        { grep -qE "Node\.js v[0-9.]+ \(>= 20\) OK" "${LOG}"; }
node_too_old()   { grep -qE "Node\.js v[0-9.]+ is too old \(need >= 20\)" "${LOG}"; }
node_will_install(){ grep -q "will install via NodeSource (--install-deps)" "${LOG}"; }
node_not_found() { grep -q "Node.js not found (need >= 20)" "${LOG}"; }

# =============================================================================
echo "== 1. the floor itself passes =="
preflight "$(fake_node v20.0.0)"
check "v20.0.0 reads OK" "node_ok"
check "v20.0.0 is not refused" "! node_too_old"

echo "== 2. the Node the installer provides passes =="
preflight "$(fake_node v22.23.3)"
check "v22.23.3 reads OK" "node_ok"

echo "== 3. a Node ahead of the floor passes and is never reinstalled =="
for v in v24.14.0 v26.12.0; do
  preflight "$(fake_node "${v}")"
  check "${v} reads OK" "node_ok"
  check "${v} is not refused" "! node_too_old"
  preflight "$(fake_node "${v}")" 1
  check "${v} with --install-deps reads OK" "node_ok"
  check "${v} with --install-deps is not marked for installation" "! node_will_install"
  check "${v} with --install-deps: no NodeSource line at all" "! grep -q NodeSource '${LOG}'"
done

echo "== 4. below the floor is refused; --install-deps installs instead =="
preflight "$(fake_node v18.19.1)"
check "v18.19.1 is refused naming the floor" "node_too_old"
check "the refusal carries the fix" "grep -q 'curl -fsSL https://deb.nodesource.com/setup_22.x' '${LOG}'"
check "the refusal is a preflight failure (node NOT modified)" "grep -q 'preflight failed — the node was NOT modified' '${LOG}'"
check "v18.19.1 does not read OK" "! node_ok"
preflight "$(fake_node v18.19.1)" 1
check "v18.19.1 with --install-deps is marked for installation" "node_will_install"
check "v18.19.1 with --install-deps is not a Node.js FATAL" "! node_too_old"

echo "== 5. no node at all =="
preflight "${WORK}/no-such-node"
check "absent node is refused" "node_not_found"
check "absent node does not read OK" "! node_ok"
preflight "${WORK}/no-such-node" 1
check "absent node with --install-deps is marked for installation" "node_will_install"

echo "== 6. a node --version that fails reads as too old, never OK =="
preflight "$(fake_node '')"
check "a failing --version is refused" "node_too_old"
check "a failing --version does not read OK" "! node_ok"

echo
echo "node-floor: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
