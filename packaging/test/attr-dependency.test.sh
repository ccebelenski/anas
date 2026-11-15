#!/usr/bin/env bash
#
# cr3.lunrestore.filemark: install.sh makes `attr` (setfattr, getfattr) a hard
# dependency, on a fresh install AND on an upgrade, in the shape rclone has.
#
# The restore mark on an image file is an extended attribute; without the two
# binaries a file-backed LUN's interrupted restore is known only from the
# daemon's job record, which a restart of the daemon loses. PVE 9 does not
# install attr on its own (ground truth 2026-11-15, fixtures/restore-mark/README.md).
#
# install.sh is sourced in ANAS_INSTALL_LIB_ONLY mode; the two binaries are
# taken away through SETFATTR_BIN/GETFATTR_BIN (names that exist nowhere), and
# apt-get is a recording stub FIRST on PATH, so nothing here installs anything,
# even when run as root on a real node.
#
#   bash packaging/test/attr-dependency.test.sh
#
# Covers:
#   1. fresh install, attr absent: the preflight marks it for install.
#   2. upgrade (an older ANAS at PREFIX), attr absent: the same.
#   3. attr present (both binaries): nothing to install; one of the two: install.
#   4. the install step: `apt-get install -y attr`, nothing else, and the probe
#      again after it.
#   5. air-gapped (apt-get fails): exit 1, the package, why, "nothing modified",
#      and the preseed command are named.
#   6. apt-get exits 0 and a binary is still missing: refused by name.
#   7. the main flow runs the install step on every run (fresh and upgrade alike).
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "${HERE}/.." && pwd)"
INSTALL="${PKG}/install.sh"

PASS=0
FAIL=0
ok()   { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }
check(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

WORK="$(mktemp -d -p "${ANAS_TEST_TMPDIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}" .scratch.XXXXXX)"
trap 'rm -rf "${WORK}"' EXIT

# Names no node has: the binaries "absent" until a stub apt-get creates them.
SETF="anas-attr-test-setfattr"
GETF="anas-attr-test-getfattr"
mkdir -p "${WORK}/bin"
# Review S2: the installer probes PATHS (the ones the daemon executes); these
# are where the stub apt-get lays the two binaries down.
SETF_PATH="${WORK}/bin/${SETF}"
GETF_PATH="${WORK}/bin/${GETF}"
BASH_PATH="$(command -v bash)"
export PATH="${WORK}/bin:${PATH}"

# apt-get stub: records its argv; APT_MODE says what it does.
#   install-both  -> lays down both binaries, exit 0
#   install-one   -> lays down setfattr only, exit 0
#   fail          -> exit 100, as apt does with no reachable mirror
cat > "${WORK}/bin/apt-get" <<EOF
#!/bin/sh
echo "apt-get \$*" >> "${WORK}/apt.log"
case "\${APT_MODE:-fail}" in
  install-both) for b in ${SETF} ${GETF}; do printf '#!/bin/sh\nexit 0\n' > "${WORK}/bin/\$b"; chmod +x "${WORK}/bin/\$b"; done; exit 0 ;;
  install-one)  printf '#!/bin/sh\nexit 0\n' > "${WORK}/bin/${SETF}"; chmod +x "${WORK}/bin/${SETF}"; exit 0 ;;
  *) echo "E: Unable to locate package attr" >&2; exit 100 ;;
esac
EOF
chmod +x "${WORK}/bin/apt-get"
# apt-mark stub (review S1): records its argv; APT_MARK_MODE=fail makes it fail.
cat > "${WORK}/bin/apt-mark" <<EOF
#!/bin/sh
echo "apt-mark \$*" >> "${WORK}/apt-mark.log"
[ "\${APT_MARK_MODE:-ok}" = fail ] && { echo "E: Unable to locate package attr" >&2; exit 100; }
echo "attr set to manually installed."
exit 0
EOF
chmod +x "${WORK}/bin/apt-mark"
[ "$(command -v apt-get)" = "${WORK}/bin/apt-get" ] || { echo "FATAL: apt-get stub not first on PATH" >&2; exit 1; }

reset_bins() { rm -f "${WORK}/bin/${SETF}" "${WORK}/bin/${GETF}" "${WORK}/apt.log" "${WORK}/apt-mark.log"; }

# Run ONLY the read-only preflight; it exits non-zero on this host's other
# facts (not root, not PVE), which do not matter here. The EXIT trap reports
# the one flag this test is about. Output -> ${LOG}.
preflight() {
  local prefix="$1"
  LOG="${WORK}/preflight.log"
  ANAS_INSTALL_LIB_ONLY=1 PREFIX="${prefix}" ANAS_ENV_FILE="${WORK}/etc-default-anas" \
  SS_BIN=true SYSTEMCTL_BIN=false SETFATTR_BIN="${SETFATTR_BIN_UNDER_TEST}" GETFATTR_BIN="${GETFATTR_BIN_UNDER_TEST}" \
    bash -c 'source "$0"; trap "echo NEED_ATTR_INSTALL=\${NEED_ATTR_INSTALL}" EXIT; phase0_preflight' "${INSTALL}" >"${LOG}" 2>&1
}

# Run ONLY the dependency step with attr marked missing (or, with $2=0, present) and nothing else.
install_deps() {
  LOG="${WORK}/deps.log"
  ANAS_INSTALL_LIB_ONLY=1 APT_MODE="$1" NEED="${2:-1}" SETFATTR_BIN="${SETF_PATH}" GETFATTR_BIN="${GETF_PATH}" \
    bash -c 'source "$0"; NEED_ATTR_INSTALL=${NEED}; phase0b_install_deps; echo "DEPS-RETURNED"' "${INSTALL}" >"${LOG}" 2>&1
  RC=$?
}

echo "== 1. fresh install, attr absent =="
reset_bins
SETFATTR_BIN_UNDER_TEST="${SETF_PATH}" GETFATTR_BIN_UNDER_TEST="${GETF_PATH}"
preflight "${WORK}/opt-anas-fresh"
check "the preflight saw a fresh install" "grep -q 'fresh install' '${LOG}'"
check "attr is marked for install" "grep -qx 'NEED_ATTR_INSTALL=1' '${LOG}'"
check "the preflight says so" "grep -qF 'attr (setfattr/getfattr) missing — will auto-install' '${LOG}'"
check "the preflight installed nothing" "[ ! -e '${WORK}/apt.log' ]"

echo "== 2. upgrade (an older ANAS installed), attr absent =="
mkdir -p "${WORK}/opt-anas-old"
echo "0.4.5" > "${WORK}/opt-anas-old/VERSION"
preflight "${WORK}/opt-anas-old"
check "the preflight saw an existing install (upgrade or reinstall)" "grep -qE '(upgrade|reinstall): ANAS' '${LOG}'"
check "attr is marked for install on the upgrade too" "grep -qx 'NEED_ATTR_INSTALL=1' '${LOG}'"
check "the preflight says so" "grep -qF 'attr (setfattr/getfattr) missing — will auto-install' '${LOG}'"

echo "== 3. attr present / half present =="
SETFATTR_BIN_UNDER_TEST="${BASH_PATH}" GETFATTR_BIN_UNDER_TEST="${BASH_PATH}"
preflight "${WORK}/opt-anas-old"
check "both binaries present: nothing to install" "grep -qx 'NEED_ATTR_INSTALL=0' '${LOG}'"
check "the preflight says present" "grep -qF 'attr (setfattr, getfattr) present' '${LOG}'"
SETFATTR_BIN_UNDER_TEST="${BASH_PATH}" GETFATTR_BIN_UNDER_TEST="${GETF_PATH}"
preflight "${WORK}/opt-anas-old"
check "getfattr missing alone: install" "grep -qx 'NEED_ATTR_INSTALL=1' '${LOG}'"
SETFATTR_BIN_UNDER_TEST="${SETF_PATH}" GETFATTR_BIN_UNDER_TEST="${BASH_PATH}"
preflight "${WORK}/opt-anas-old"
check "setfattr missing alone: install" "grep -qx 'NEED_ATTR_INSTALL=1' '${LOG}'"

echo "== 4. the install step =="
reset_bins
install_deps install-both
check "it returned (exit 0)" "[ ${RC} -eq 0 ] && grep -q DEPS-RETURNED '${LOG}'"
check "apt-get was asked for attr, exactly" "[ \"\$(cat '${WORK}/apt.log')\" = 'apt-get install -y attr' ]"
check "it says attr installed" "grep -qF 'attr installed' '${LOG}'"

echo "== 5. air-gapped: apt-get fails =="
reset_bins
install_deps fail
check "the installer stops (exit 1)" "[ ${RC} -eq 1 ] && ! grep -q DEPS-RETURNED '${LOG}'"
check "names the package" "grep -qF \"failed to install the required package 'attr'.\" '${LOG}'"
check "says why it is required" "grep -qF 'restore mark on image files' '${LOG}'"
check "says nothing was modified" "grep -qF 'Nothing on this node was modified' '${LOG}'"
check "names the preseed command" "grep -qF \"apt-get install -y --no-download attr\" '${LOG}'"

echo "== 6. apt-get exits 0, getfattr still missing =="
reset_bins
install_deps install-one
check "the installer stops (exit 1)" "[ ${RC} -eq 1 ] && ! grep -q DEPS-RETURNED '${LOG}'"
check "says which package failed" "grep -qF 'attr install failed (setfattr or getfattr still missing)' '${LOG}'"

echo "== 7. the main flow: the install step runs on every run =="
MAIN="$(sed -n '/^if \[ "\${ANAS_INSTALL_LIB_ONLY:-0}" != "1" \]; then$/,/^fi$/p' "${INSTALL}")"
check "main runs preflight, then the dependency step, then the install, unconditionally" \
  "[ \"\$(printf '%s\n' \"\${MAIN}\" | sed -n '2,4p' | tr -d ' ')\" = \"\$(printf 'phase0_preflight\nphase0b_install_deps\nphase1_install')\" ]"
check "the dependency step is not gated on fresh vs upgrade" \
  "! sed -n '/^phase0b_install_deps() {/,/^}/p' '${INSTALL}' | grep -qE 'OLD_VERSION|NEW_VERSION|PREFIX'"

echo "== 8. review S1: attr is marked manually installed, so apt autoremove never takes it =="
reset_bins
install_deps install-both
check "after installing it: apt-mark manual attr" "[ \"\$(cat '${WORK}/apt-mark.log')\" = 'apt-mark manual attr' ]"
check "after installing it: says so" "grep -qF 'attr marked as manually installed' '${LOG}'"
reset_bins
install_deps fail 0
check "already present: no apt-get, and still apt-mark manual attr" "[ ! -e '${WORK}/apt.log' ] && [ \"\$(cat '${WORK}/apt-mark.log')\" = 'apt-mark manual attr' ]"
check "already present: the step returns (exit 0)" "[ ${RC} -eq 0 ] && grep -q DEPS-RETURNED '${LOG}'"
reset_bins
APT_MARK_MODE=fail install_deps fail 0
check "apt-mark fails (attr not from a package): the installer goes on (exit 0)" "[ ${RC} -eq 0 ] && grep -q DEPS-RETURNED '${LOG}'"
check "apt-mark fails: an info line says what it could not do and what that leaves" "grep -qF 'could not mark attr as manually installed' '${LOG}'"

echo "== 9. review S2: the installer proves the paths the daemon executes, not whatever PATH finds =="
DAEMON="${PKG}/../packages/daemon/src/services/restore-mark.ts"
d_set="$(sed -n "s/^export const SETFATTR = '\(.*\)'$/\1/p" "${DAEMON}")"
d_get="$(sed -n "s/^export const GETFATTR = '\(.*\)'$/\1/p" "${DAEMON}")"
i_set="$(sed -n 's/^SETFATTR_BIN="\${SETFATTR_BIN:-\(.*\)}"$/\1/p' "${INSTALL}")"
i_get="$(sed -n 's/^GETFATTR_BIN="\${GETFATTR_BIN:-\(.*\)}"$/\1/p' "${INSTALL}")"
check "the daemon runs /usr/bin/setfattr and /usr/bin/getfattr" "[ '${d_set}' = /usr/bin/setfattr ] && [ '${d_get}' = /usr/bin/getfattr ]"
check "the installer's defaults are exactly those paths" "[ '${i_set}' = '${d_set}' ] && [ '${i_get}' = '${d_get}' ]"
# A setfattr and a getfattr on PATH, but not at the probed paths: missing.
printf '#!/bin/sh\nexit 0\n' > "${WORK}/bin/setfattr"; printf '#!/bin/sh\nexit 0\n' > "${WORK}/bin/getfattr"
chmod +x "${WORK}/bin/setfattr" "${WORK}/bin/getfattr"
SETFATTR_BIN_UNDER_TEST="${WORK}/nowhere/setfattr" GETFATTR_BIN_UNDER_TEST="${WORK}/nowhere/getfattr"
preflight "${WORK}/opt-anas-old"
check "binaries on PATH elsewhere do not count: attr is marked for install" "grep -qx 'NEED_ATTR_INSTALL=1' '${LOG}'"
rm -f "${WORK}/bin/setfattr" "${WORK}/bin/getfattr"

echo
echo "attr-dependency: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
