#!/usr/bin/env bash
#
# Tests for the retired index.html.tpl.anas-orig copy (cr.61, review L5).
# Older installs took a one-time whole-file copy of pve-manager's
# index.html.tpl that nothing ever read; after a pve-manager upgrade it is a
# stale PVE file a by-hand "restore" would downgrade the UI with. install.sh no
# longer takes it, and both install.sh and uninstall.sh remove one left behind.
#
# Both scripts are sourced in their LIB_ONLY modes against a throwaway
# PVE_TPL — no root, no real node.
#
#   bash packaging/test/tpl-backup.test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL="${HERE}/../install.sh"
UNINSTALL="${HERE}/../uninstall.sh"

PASS=0
FAIL=0
check() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "  ok   ${desc}"; PASS=$((PASS + 1))
  else
    echo "  FAIL ${desc}"; FAIL=$((FAIL + 1))
  fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
TPL="${WORK}/index.html.tpl"

make_tpl() {
  printf '<html>\n<script src="/pve2/js/pvemanagerlib.js"></script>\n</html>\n' > "${TPL}"
  printf '<html>STALE COPY FROM AN OLDER PVE</html>\n' > "${TPL}.anas-orig"
  cksum < "${TPL}" > "${WORK}/tpl.sum"
}

echo "== 1. install removes a stale .anas-orig, and leaves the template alone =="
make_tpl
ANAS_INSTALL_LIB_ONLY=1 PVE_TPL="${TPL}" bash -c 'source "$0"; sweep_stale_tpl_backup' "${INSTALL}" > "${WORK}/install.log" 2>&1
check "the stale copy is gone" bash -c "! test -e '${TPL}.anas-orig'"
check "the template is byte-identical" bash -c "cksum < '${TPL}' | cmp -s - '${WORK}/tpl.sum'"
check "the removal is said" grep -q 'removed stale .*index.html.tpl.anas-orig' "${WORK}/install.log"

echo "== 2. install with no stale copy says nothing and creates none =="
rm -f "${TPL}.anas-orig"
ANAS_INSTALL_LIB_ONLY=1 PVE_TPL="${TPL}" bash -c 'source "$0"; sweep_stale_tpl_backup' "${INSTALL}" > "${WORK}/install2.log" 2>&1
check "no copy created" bash -c "! test -e '${TPL}.anas-orig'"
check "nothing printed" test ! -s "${WORK}/install2.log"

echo "== 3. install's UI step sweeps, and no line takes a copy any more =="
check "phase1_install calls the sweep" \
  bash -c "awk '/^phase1_install\\(\\)/{f=1} f && /sweep_stale_tpl_backup/{print \"yes\"; exit}' '${INSTALL}' | grep -q yes"
check "install.sh never copies anything to a .anas-orig" \
  bash -c "! grep -nE '^[^#]*(cp|install|mv)[^#]*\\.anas-orig' '${INSTALL}'"

echo "== 4. uninstall removes a stale .anas-orig =="
make_tpl
ANAS_UNINSTALL_LIB_ONLY=1 PVE_TPL="${TPL}" bash -c 'source "$0"; sweep_stale_tpl_backup' "${UNINSTALL}" > "${WORK}/uninstall.log" 2>&1
check "the stale copy is gone" bash -c "! test -e '${TPL}.anas-orig'"
check "the template is byte-identical (the script line is pve-integration's to remove)" \
  bash -c "cksum < '${TPL}' | cmp -s - '${WORK}/tpl.sum'"
check "uninstall's main flow calls the sweep" \
  bash -c "awk '/ANAS_UNINSTALL_LIB_ONLY:-0/{f=1} f && /^sweep_stale_tpl_backup\$/{print \"yes\"; exit}' '${UNINSTALL}' | grep -q yes"

echo
echo "tpl-backup tests: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
