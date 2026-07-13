#!/usr/bin/env bash
#
# Uninstall the ANAS PVE web UI integration, restoring the pristine template.
#
# Surgical reverse of install.sh: remove only our <script> line (preserving
# every other byte of index.html.tpl verbatim), remove our JS file, and remove
# the apt hook.
#
# Paths are parameterised (with production defaults) for testing:
#   PVE_TPL=/tmp/x/index.html.tpl PVE_JS_DIR=/tmp/x/js APT_HOOK=/tmp/x/hook ./uninstall.sh
#
set -euo pipefail

PVE_TPL="${PVE_TPL:-/usr/share/pve-manager/index.html.tpl}"
PVE_JS_DIR="${PVE_JS_DIR:-/usr/share/pve-manager/js}"
APT_HOOK="${APT_HOOK:-/etc/apt/apt.conf.d/80anas-pve-integration}"

SCRIPT_SRC="/pve2/js/anas.js"

# 1. Remove our line from the template — and only our line. We match on the
#    exact script source so no other line can be touched. Removing the whole
#    line (including its newline) leaves the file byte-identical to pristine.
if [ -f "${PVE_TPL}" ] && grep -qF "${SCRIPT_SRC}" "${PVE_TPL}"; then
  tmp="$(mktemp)"
  # \|...|d uses | as the delimiter so the /pve2/js/... slashes need no escaping.
  sed "\|${SCRIPT_SRC}|d" "${PVE_TPL}" > "${tmp}"
  cat "${tmp}" > "${PVE_TPL}"
  rm -f "${tmp}"
  echo "anas: removed script line from ${PVE_TPL}"
else
  echo "anas: no script line in ${PVE_TPL} (nothing to do)"
fi

# 2. Remove our JS file.
if [ -f "${PVE_JS_DIR}/anas.js" ]; then
  rm -f "${PVE_JS_DIR}/anas.js"
  echo "anas: removed ${PVE_JS_DIR}/anas.js"
fi

# 3. Remove the apt hook.
if [ -f "${APT_HOOK}" ]; then
  rm -f "${APT_HOOK}"
  echo "anas: removed apt hook ${APT_HOOK}"
fi

echo "anas: PVE UI integration uninstalled."
