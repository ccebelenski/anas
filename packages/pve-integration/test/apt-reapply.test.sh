#!/usr/bin/env bash
#
# Tests for packages/pve-integration/apt-reapply.sh — the body of the ANAS
# DPkg::Post-Invoke apt hook (story installer.1, GitHub #74).
#
# The real wrapper is copied into a throwaway directory beside a FAKE install.sh
# (the wrapper runs the installer next to it), and `logger` and `perl` are
# shimmed onto PATH to capture what would reach journald and PVE::Notify — the
# md-event harness pattern. No apt, no PVE, no root.
#
# Covers:
#   1. success: start line, the installer's output, result STATUS=0; no notify.
#   2. installer exits 1: result line RESULT=failed STATUS=1 at warning, ONE
#      PVE notification (warning, anas-integration) naming the manual fix and
#      carrying the installer's ERROR line; the wrapper still exits 0.
#   3. installer missing (renamed): STATUS=127, InstallerMissing, notified.
#   4. notification delivery fails: NotifyForwardFailed logged, exit 0.
#   5. logger itself fails: the installer still runs, the notify still goes,
#      exit 0 — a broken journald path never stops the re-apply.
#   6. the captured-output temp file is removed on success and on failure.
#
# The hook LINE (shape, `[ -x … ]`, `|| true`, never failing apt) is covered by
# proxy-install.test.sh section 12, which runs the real install.sh.
#
#   bash packages/pve-integration/test/apt-reapply.test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "${HERE}/.." && pwd)"
WRAPPER_SRC="${PKG}/apt-reapply.sh"

PASS=0
FAIL=0
ok()   { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

STAGE="${WORK}/pve-integration"
BIN="${WORK}/bin"
mkdir -p "${STAGE}" "${BIN}" "${WORK}/tmp"
cp "${WRAPPER_SRC}" "${STAGE}/apt-reapply.sh"
chmod +x "${STAGE}/apt-reapply.sh"

# Fake installer: prints a little, records that it ran, exits FAKE_RC.
make_installer() {
  cat > "${STAGE}/install.sh" <<EOF
#!/usr/bin/env bash
echo "anas: installed /usr/share/pve-manager/js/anas.js (generated from src/)"
if [ "\${FAKE_RC:-0}" -ne 0 ]; then
  echo "anas: ERROR: no pvemanagerlib.js line in /usr/share/pve-manager/index.html.tpl; refusing to guess" >&2
fi
touch "${WORK}/installer-ran"
exit "\${FAKE_RC:-0}"
EOF
  chmod +x "${STAGE}/install.sh"
}

# logger shim: one line per call with its argv; in stdin mode (no `--`
# message) one "STDIN" line per input line. FAKE_LOGGER_RC makes it fail.
cat > "${BIN}/logger" <<EOF
#!/usr/bin/env bash
case " \$* " in
  *" -- "*) printf 'ARGV %s\n' "\$*" >> "${WORK}/logger.log" ;;
  *) while IFS= read -r line; do printf 'STDIN %s | %s\n' "\$*" "\${line}" >> "${WORK}/logger.log"; done ;;
esac
exit "\${FAKE_LOGGER_RC:-0}"
EOF
# perl shim: each argv element on its own line, a separator per call.
cat > "${BIN}/perl" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do printf '%s\n' "\${a}" >> "${WORK}/perl.log"; done
printf '%s\n' '---END-CALL---' >> "${WORK}/perl.log"
exit "\${FAKE_PERL_RC:-0}"
EOF
chmod +x "${BIN}/logger" "${BIN}/perl"

run_wrapper() {
  : > "${WORK}/logger.log"; : > "${WORK}/perl.log"
  rm -f "${WORK}/installer-ran"
  PATH="${BIN}:${PATH}" TMPDIR="${WORK}/tmp" \
  FAKE_RC="${FAKE_RC:-0}" FAKE_PERL_RC="${FAKE_PERL_RC:-0}" FAKE_LOGGER_RC="${FAKE_LOGGER_RC:-0}" \
    "${STAGE}/apt-reapply.sh" >"${WORK}/wrapper.out" 2>&1
}

INST="${STAGE}/install.sh"
TAGP="-t anas-pve-integration"
perl_calls() { grep -c '^---END-CALL---$' "${WORK}/perl.log"; }

# =============================================================================
echo "== 1. success: start, output, result STATUS=0, no notification =="
make_installer
FAKE_RC=0 run_wrapper; rc=$?
check "wrapper exits 0" "[ ${rc} -eq 0 ]"
check "installer ran" "[ -f '${WORK}/installer-ran' ]"
check "start line logged under the tag" \
  "grep -qF 'ARGV ${TAGP} -p daemon.info -- EVENT=ReapplyStart TRIGGER=dpkg-post-invoke INSTALLER=${INST}' '${WORK}/logger.log'"
check "installer output logged under the tag" \
  "grep -qF 'STDIN ${TAGP} -p daemon.info | anas: installed /usr/share/pve-manager/js/anas.js' '${WORK}/logger.log'"
check "result line carries STATUS=0" \
  "grep -qF 'ARGV ${TAGP} -p daemon.info -- EVENT=ReapplyResult RESULT=ok STATUS=0' '${WORK}/logger.log'"
check "start line comes before the result line" \
  "[ \"\$(grep -n 'ReapplyStart' '${WORK}/logger.log' | cut -d: -f1)\" -lt \"\$(grep -n 'ReapplyResult' '${WORK}/logger.log' | cut -d: -f1)\" ]"
check "no notification on success" "[ ! -s '${WORK}/perl.log' ]"
check "nothing printed to apt's terminal" "[ ! -s '${WORK}/wrapper.out' ]"
check "captured output removed" "[ -z \"\$(ls -A '${WORK}/tmp')\" ]"

echo "== 2. installer exits 1: failure line + one PVE notification, exit 0 =="
make_installer
FAKE_RC=1 run_wrapper; rc=$?
check "wrapper still exits 0 (apt never fails)" "[ ${rc} -eq 0 ]"
check "result line: RESULT=failed STATUS=1 at warning, names the fix" \
  "grep -qF 'ARGV ${TAGP} -p daemon.warning -- EVENT=ReapplyResult RESULT=failed STATUS=1 FIX=${INST}' '${WORK}/logger.log'"
check "the installer's stderr reached journald too" \
  "grep -qF 'STDIN ${TAGP} -p daemon.info | anas: ERROR: no pvemanagerlib.js line' '${WORK}/logger.log'"
check "exactly one notification" "[ \"\$(perl_calls)\" = '1' ]"
check "notification goes through PVE::Notify" "grep -qF 'PVE::Notify::notify' '${WORK}/perl.log'"
check "notification uses the anas-integration template and type" \
  "grep -qF '{ type => \"anas-integration\" }' '${WORK}/perl.log' && grep -qF 'notify(\$sev, \"anas-integration\"' '${WORK}/perl.log'"
check "severity is warning" "grep -qx 'warning' '${WORK}/perl.log'"
check "title says the integration could not be re-applied" \
  "grep -q '^PVE UI integration could not be re-applied on ' '${WORK}/perl.log'"
check "message says it follows a package upgrade" \
  "grep -qF 'After a package upgrade or install on ' '${WORK}/perl.log' && grep -qF 'the ANAS PVE UI integration could not be re-applied' '${WORK}/perl.log'"
check "message carries the exit status" "grep -qF 'exited with status 1' '${WORK}/perl.log'"
check "message carries the installer's ERROR line" "grep -qF 'anas: ERROR: no pvemanagerlib.js line' '${WORK}/perl.log'"
check "message names the manual fix (run the installer as root)" \
  "grep -qF 'To fix, run as root on ' '${WORK}/perl.log' && grep -qxF '  ${INST}' '${WORK}/perl.log'"
check "message points at the journald tag" "grep -qF 'journalctl -t anas-pve-integration' '${WORK}/perl.log'"
check "notification outcome logged" \
  "grep -qF 'ARGV ${TAGP} -p daemon.info -- EVENT=NotifySent TEMPLATE=anas-integration SEVERITY=warning' '${WORK}/logger.log'"
check "captured output removed" "[ -z \"\$(ls -A '${WORK}/tmp')\" ]"

echo "== 3. installer renamed away: STATUS=127, notified, exit 0 =="
make_installer
mv "${STAGE}/install.sh" "${STAGE}/install.sh.off"
FAKE_RC=0 run_wrapper; rc=$?
check "wrapper exits 0" "[ ${rc} -eq 0 ]"
check "InstallerMissing logged" \
  "grep -qF 'ARGV ${TAGP} -p daemon.err -- EVENT=InstallerMissing INSTALLER=${INST}' '${WORK}/logger.log'"
check "result line STATUS=127" "grep -qF 'EVENT=ReapplyResult RESULT=failed STATUS=127' '${WORK}/logger.log'"
check "one notification" "[ \"\$(perl_calls)\" = '1' ]"
check "message says the installer is missing" "grep -qF 'is missing or not executable' '${WORK}/perl.log'"
mv "${STAGE}/install.sh.off" "${STAGE}/install.sh"

echo "== 4. notification delivery fails: logged, exit 0 =="
FAKE_RC=1 FAKE_PERL_RC=2 run_wrapper; rc=$?
check "wrapper exits 0" "[ ${rc} -eq 0 ]"
check "NotifyForwardFailed logged at warning" \
  "grep -qF 'ARGV ${TAGP} -p daemon.warning -- EVENT=NotifyForwardFailed TEMPLATE=anas-integration' '${WORK}/logger.log'"
check "no NotifySent claimed" "! grep -q 'NotifySent' '${WORK}/logger.log'"

echo "== 5. logger fails: the re-apply and the notification still happen =="
FAKE_RC=1 FAKE_LOGGER_RC=1 run_wrapper; rc=$?
check "wrapper exits 0" "[ ${rc} -eq 0 ]"
check "installer still ran" "[ -f '${WORK}/installer-ran' ]"
check "notification still sent" "[ \"\$(perl_calls)\" = '1' ]"

echo
echo "apt-reapply tests: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
