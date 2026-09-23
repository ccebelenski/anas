#!/usr/bin/env bash
#
# Tests for the recycle-bin purge packaging (smbsvc.2): the static
# anas-recycle.timer/.service pair shipped in packaging/systemd, the purge
# runner built into app/packages/daemon/dist/recycle-purge.js, and the wiring
# in install.sh (preflight + install_units + enable) and uninstall.sh
# (remove_recycle_units — which must never touch any #recycle contents).
#
# The unit pair is static for ALL shares: the purge age lives in each stanza's
# `# anas:recycle-purge-days` marker in smb.conf, so install/uninstall have
# nothing per-share to create or remove. uninstall.sh is exercised in
# ANAS_UNINSTALL_LIB_ONLY mode with a throwaway SYSTEMD_DIR/stamp dir and a
# faked systemctl (the uninstall-schedules pattern) — no root, no real node.
#
#   bash packaging/test/recycle-units.test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "${HERE}/.." && pwd)"
SYSTEMD_SRC="${PKG}/systemd"
TIMER="${SYSTEMD_SRC}/anas-recycle.timer"
SERVICE="${SYSTEMD_SRC}/anas-recycle.service"
INSTALL="${PKG}/install.sh"
UNINSTALL="${PKG}/uninstall.sh"
RELEASE="${PKG}/make-release.sh"

PASS=0
FAIL=0
check(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }
ok()   { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

SYSTEMD_DIR="${WORK}/systemd"
STAMPS="${WORK}/timers"
SYSTEMCTL="${WORK}/systemctl"
mkdir -p "${SYSTEMD_DIR}" "${STAMPS}"

# Faked systemctl: record argv, always succeed.
cat > "${SYSTEMCTL}" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${WORK}/systemctl.log"
exit 0
EOF
chmod +x "${SYSTEMCTL}"

echo "== 1. the unit pair is well-formed =="
check "timer exists" "[ -f '${TIMER}' ]"
check "service exists" "[ -f '${SERVICE}' ]"
check "timer fires daily" "grep -qE '^OnCalendar=daily$' '${TIMER}'"
check "timer is Persistent (catches up a reboot)" "grep -qE '^Persistent=true$' '${TIMER}'"
check "timer installs into timers.target" "grep -qE '^WantedBy=timers.target$' '${TIMER}'"
check "service is oneshot" "grep -qE '^Type=oneshot$' '${SERVICE}'"
check "service runs the compiled purge runner" \
  "grep -qE '^ExecStart=/usr/bin/node /opt/anas/packages/daemon/dist/recycle-purge.js$' '${SERVICE}'"

echo "== 2. systemd-analyze verify (when available) =="
# On a dev host, verify also walks unrelated system units it cannot read (and
# the runner path under /opt/anas does not exist) — only complaints naming OUR
# unit count. Syntax/unknown-key problems always do.
if command -v systemd-analyze >/dev/null 2>&1; then
  for u in anas-recycle.timer anas-recycle.service; do
    out="$(systemd-analyze verify "${SYSTEMD_SRC}/${u}" 2>&1 | grep -F "${u}" | grep -v 'recycle-purge.js' || true)"
    check "${u} verifies (modulo dev-host noise)" "[ -z \"\$(printf '%s' \"\${out}\")\" ]"
  done
else
  echo "  skip systemd-analyze not available (shape checks above stand)"
fi

echo "== 3. install.sh wires the pair =="
check "preflight requires the timer" "grep -qF 'release incomplete: systemd/\${RECYCLE_TIMER}' '${INSTALL}'"
check "preflight requires the runner in app/dist" "grep -qF 'release incomplete: app/packages/daemon/dist/recycle-purge.js' '${INSTALL}'"
check "install_units installs both unit files" "grep -qF 'for u in \"\${RECYCLE_SERVICE}\" \"\${RECYCLE_TIMER}\"' '${INSTALL}'"
check "the timer is enabled --now at install" "grep -qF 'systemctl enable --now anas-recycle.timer' '${INSTALL}'"
check "rollback disables and removes the pair" \
  "grep -qF 'systemctl disable --now anas-recycle.timer' '${INSTALL}' && grep -qF 'rm -f \"\${SYSTEMD_DIR}/\${RECYCLE_TIMER}\" \"\${SYSTEMD_DIR}/\${RECYCLE_SERVICE}\"' '${INSTALL}'"

check "install_units lands the service beside the ANAS units" \
  "ANAS_INSTALL_LIB_ONLY=1 SYSTEMD_DIR='${SYSTEMD_DIR}' PREFIX=/opt/anas bash -c 'source \"\$0\"; install_units' '${INSTALL}' && test -f '${SYSTEMD_DIR}/anas-recycle.service'"
check "install_units lands the timer" "test -f '${SYSTEMD_DIR}/anas-recycle.timer'"

echo "== 4. uninstall.sh removes the pair, never the bins =="
check "remove_recycle_units is defined before the lib-mode guard" \
  bash -c "awk '/^remove_recycle_units\(\)/{f=1} /ANAS_UNINSTALL_LIB_ONLY/{print f; exit}' '${UNINSTALL}' | grep -q true"
check "it disables the timer before removing it" \
  bash -c "sed -n '/^remove_recycle_units()/,/^}/p' '${UNINSTALL}' | grep -qF 'systemctl disable --now anas-recycle.timer'"
check "it removes both unit files and the Persistent stamp" \
  bash -c "sed -n '/^remove_recycle_units()/,/^}/p' '${UNINSTALL}' | grep -qF 'stamp-anas-recycle.timer'"
check "it states that #recycle contents stay" \
  bash -c "sed -n '/^remove_recycle_units()/,/^}/p' '${UNINSTALL}' | grep -qF 'every #recycle directory and its contents are left in place'"
check "it runs in the main flow" "grep -qE '^remove_recycle_units$' '${UNINSTALL}'"

# Behaviour, lib-mode with the faked systemctl.
: > "${WORK}/systemctl.log"
printf '[Timer]\n' > "${SYSTEMD_DIR}/anas-recycle.timer"
printf '[Service]\n' > "${SYSTEMD_DIR}/anas-recycle.service"
: > "${STAMPS}/stamp-anas-recycle.timer"
PATH="$(dirname "${SYSTEMCTL}"):${PATH}" SYSTEMD_DIR="${SYSTEMD_DIR}" TIMERS_STAMP_DIR="${STAMPS}" \
  ANAS_UNINSTALL_LIB_ONLY=1 bash -c "source '${UNINSTALL}'; remove_recycle_units" > "${WORK}/out.log" 2>&1
check "the timer was disabled" "grep -qF 'disable --now anas-recycle.timer' '${WORK}/systemctl.log'"
check "both unit files removed" \
  bash -c "! test -e '${SYSTEMD_DIR}/anas-recycle.timer' && ! test -e '${SYSTEMD_DIR}/anas-recycle.service'"
check "the Persistent stamp removed" bash -c "! test -e '${STAMPS}/stamp-anas-recycle.timer'"
check "a second run is a no-op (idempotent)" \
  bash -c "! grep -qF 'anas-recycle' <(PATH=\"\$(dirname '${SYSTEMCTL}'):\$PATH\" SYSTEMD_DIR='${SYSTEMD_DIR}' TIMERS_STAMP_DIR='${STAMPS}' ANAS_UNINSTALL_LIB_ONLY=1 bash -c \"source '${UNINSTALL}'; remove_recycle_units\" 2>&1)"

echo "== 5. make-release stages the pair =="
check "timer staged into systemd/" "grep -qF 'systemd/anas-recycle.timer' '${RELEASE}'"
check "service staged into systemd/" "grep -qF 'systemd/anas-recycle.service' '${RELEASE}'"

echo
echo "recycle-units tests: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
