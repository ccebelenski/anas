#!/usr/bin/env bash
#
# Tests for the operator-configurable gateway port machinery in
# packaging/install.sh (issue #2). Modeled on the pve-integration test harness:
# install.sh is sourced in ANAS_INSTALL_LIB_ONLY mode so its pure helpers
# (resolve_port, write_env_file, install_units) run against throwaway paths with
# faked ss/systemctl — no real PVE, node, or service manager involved.
#
# Covers the port-resolution precedence:
#   1. --port wins; a FOREIGN listener on it is a hard error.
#   2. an existing /etc/default/anas value is PRESERVED (upgrades never re-pick).
#   3. default 3000, auto-scanning past a foreign listener on a fresh install;
#      but OUR own running gateway on the port is not a conflict.
# Plus: --port writes /etc/default/anas, and anas.service carries EnvironmentFile.
#
#   bash packaging/test/port-config.test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "${HERE}/.." && pwd)"
INSTALL="${PKG}/install.sh"
UNIT_SRC="${PKG}/systemd"

PASS=0
FAIL=0
ok()   { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# Per-test scratch + fakes. FAKE_SS_PORTS (space-separated) are the ports the
# fake ss reports as LISTENing; FAKE_ANAS_ACTIVE=1 makes the fake systemctl
# report the anas service active.
setup_env() {
  WORK="$(mktemp -d)"
  ENV_FILE="${WORK}/anas.env"
  FAKE_SS="${WORK}/ss"
  FAKE_SYSTEMCTL="${WORK}/systemctl"
  cat > "${FAKE_SS}" <<'EOF'
#!/usr/bin/env bash
for p in ${FAKE_SS_PORTS:-}; do printf 'LISTEN 0 128 127.0.0.1:%s 0.0.0.0:*\n' "$p"; done
EOF
  cat > "${FAKE_SYSTEMCTL}" <<'EOF'
#!/usr/bin/env bash
[ "$*" = "is-active --quiet anas" ] && { [ "${FAKE_ANAS_ACTIVE:-0}" = "1" ] && exit 0 || exit 3; }
exit 0
EOF
  chmod +x "${FAKE_SS}" "${FAKE_SYSTEMCTL}"
  FAKE_SS_PORTS=""
  FAKE_ANAS_ACTIVE=0
}

# Source install.sh in library mode and run resolve_port (+ optional extra
# snippet). Extra CLI args (e.g. --port 3001) are passed through. Echoes
# whatever the snippet prints; captures stdout+stderr; returns the exit code.
lib() {
  local snippet="$1"; shift
  ANAS_INSTALL_LIB_ONLY=1 \
  ANAS_ENV_FILE="${ENV_FILE}" \
  SS_BIN="${FAKE_SS}" SYSTEMCTL_BIN="${FAKE_SYSTEMCTL}" \
  FAKE_SS_PORTS="${FAKE_SS_PORTS}" FAKE_ANAS_ACTIVE="${FAKE_ANAS_ACTIVE}" \
    bash -c "source \"\$0\"; ${snippet}" "${INSTALL}" "$@"
}

# Pull the @@<port>@@ marker a snippet prints out of captured (log-polluted)
# stdout — info()/warn() also write there, so the value must be delimited.
port_of() { printf '%s' "$1" | sed -n 's/.*@@\([0-9]*\)@@.*/\1/p'; }

# =============================================================================
echo "== 1. --port on a fresh node: resolves + writes /etc/default/anas =="
setup_env
out="$(lib 'resolve_port; write_env_file "$RESOLVED_PORT"; printf "@@%s@@" "$RESOLVED_PORT"' --port 3131 2>/dev/null)"; rc=$?
check "exits 0" "[ ${rc} -eq 0 ]"
check "resolves to the requested port" "[ \"\$(port_of '${out}')\" = '3131' ]"
check "env file written" "[ -f '${ENV_FILE}' ]"
check "env file carries ANAS_PORT=3131" "grep -qx 'ANAS_PORT=3131' '${ENV_FILE}'"
rm -rf "${WORK}"

echo "== 2. --port held by a FOREIGN listener: hard error, no env file =="
setup_env
FAKE_SS_PORTS="3140"; FAKE_ANAS_ACTIVE=0
out="$(lib 'resolve_port; write_env_file "$RESOLVED_PORT"' --port 3140 2>&1)"; rc=$?
check "exits non-zero" "[ ${rc} -ne 0 ]"
check "error names the conflict" "printf '%s' \"${out}\" | grep -qi 'already in use'"
check "no env file written on abort" "[ ! -f '${ENV_FILE}' ]"
rm -rf "${WORK}"

echo "== 3. --port with a non-numeric value is rejected =="
setup_env
out="$(lib 'resolve_port' --port abc 2>&1)"; rc=$?
check "exits non-zero" "[ ${rc} -ne 0 ]"
check "error names a valid port range" "printf '%s' \"${out}\" | grep -qi 'valid port'"
rm -rf "${WORK}"

echo "== 4. upgrade: an existing configured port is PRESERVED (no re-pick) =="
setup_env
printf 'ANAS_PORT=3222\n' > "${ENV_FILE}"
# Even with that very port 'listening' and anas active, no --port => preserve.
FAKE_SS_PORTS="3222"; FAKE_ANAS_ACTIVE=1
out="$(lib 'resolve_port; write_env_file "$RESOLVED_PORT"; printf "@@%s@@" "$RESOLVED_PORT"' 2>/dev/null)"; rc=$?
check "exits 0" "[ ${rc} -eq 0 ]"
check "preserves the configured port" "[ \"\$(port_of '${out}')\" = '3222' ]"
check "env file still ANAS_PORT=3222" "grep -qx 'ANAS_PORT=3222' '${ENV_FILE}'"
rm -rf "${WORK}"

echo "== 5. fresh install, 3000 held by a FOREIGN listener: auto-scan upward =="
setup_env
FAKE_SS_PORTS="3000"; FAKE_ANAS_ACTIVE=0
out="$(lib 'resolve_port; printf "@@%s@@" "$RESOLVED_PORT"' 2>/dev/null)"; rc=$?
log="$(lib 'resolve_port' 2>&1)"
check "exits 0" "[ ${rc} -eq 0 ]"
check "scans to the first free port (3001)" "[ \"\$(port_of '${out}')\" = '3001' ]"
check "logs the chosen port loudly" "printf '%s' \"${log}\" | grep -qi '3001'"
rm -rf "${WORK}"

echo "== 6. fresh install, 3000 held by OUR OWN gateway: not a conflict =="
setup_env
# No env file (upgrade from a pre-issue-#2 install) => our port is 3000; the
# active anas service on 3000 is ours, so we must keep 3000, not scan away.
FAKE_SS_PORTS="3000"; FAKE_ANAS_ACTIVE=1
out="$(lib 'resolve_port; printf "@@%s@@" "$RESOLVED_PORT"' 2>/dev/null)"; rc=$?
check "exits 0" "[ ${rc} -eq 0 ]"
check "keeps 3000 (our own listener)" "[ \"\$(port_of '${out}')\" = '3000' ]"
rm -rf "${WORK}"

echo "== 7. fresh install, nothing listening: default 3000 =="
setup_env
out="$(lib 'resolve_port; printf "@@%s@@" "$RESOLVED_PORT"' 2>/dev/null)"; rc=$?
check "exits 0" "[ ${rc} -eq 0 ]"
check "defaults to 3000" "[ \"\$(port_of '${out}')\" = '3000' ]"
rm -rf "${WORK}"

echo "== 8. write_env_file: format + permissions =="
setup_env
lib 'write_env_file 3199' >/dev/null 2>&1
check "env file exists" "[ -f '${ENV_FILE}' ]"
check "single ANAS_PORT line, correct value" "[ \"\$(grep -c '^ANAS_PORT=' '${ENV_FILE}')\" = '1' ] && grep -qx 'ANAS_PORT=3199' '${ENV_FILE}'"
check "mode 0644" "[ \"\$(stat -c '%a' '${ENV_FILE}')\" = '644' ]"
rm -rf "${WORK}"

echo "== 9. install_units plumbs EnvironmentFile into the installed anas.service =="
setup_env
SD="${WORK}/systemd-dir"; mkdir -p "${SD}"
ANAS_INSTALL_LIB_ONLY=1 SYSTEMD_DIR="${SD}" PREFIX=/opt/anas \
  bash -c 'source "$0"; install_units' "${INSTALL}" >/dev/null 2>&1
check "anas.service installed" "[ -f '${SD}/anas.service' ]"
check "installed unit has EnvironmentFile=-/etc/default/anas" \
  "grep -qF 'EnvironmentFile=-/etc/default/anas' '${SD}/anas.service'"
rm -rf "${WORK}"

echo "== 10. the shipped anas.service unit carries the EnvironmentFile line =="
check "systemd/anas.service references /etc/default/anas" \
  "grep -qF 'EnvironmentFile=-/etc/default/anas' '${UNIT_SRC}/anas.service'"

echo
echo "port-config tests: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
