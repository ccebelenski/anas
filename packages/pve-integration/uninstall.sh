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

# Reverse-proxy transport (story 12.2). Mirror install.sh's parameters.
PERL_BIN="${PERL_BIN:-perl}"
PVE_HTTP_SERVER_PM="${PVE_HTTP_SERVER_PM:-/usr/share/perl5/PVE/APIServer/AnyEvent.pm}"
ANAS_PERL_DIR="${ANAS_PERL_DIR:-/usr/share/anas/perl}"
ANAS_PROXY_PM="${ANAS_PERL_DIR}/AnasProxy.pm"
PVE_HTTP_SERVER_PM_ORIG="${PVE_HTTP_SERVER_PM}.anas-orig"
ANAS_HOOK_MARKER='# >>> ANAS proxy hook'
ANAS_HOOK_END='# <<< ANAS proxy hook'
PVEPROXY_RESTART_CMD="${PVEPROXY_RESTART_CMD:-}"

restart_pveproxy() {
  if [ -n "${PVEPROXY_RESTART_CMD}" ]; then
    eval "${PVEPROXY_RESTART_CMD}"
    return $?
  fi
  systemctl reset-failed pveproxy >/dev/null 2>&1 || true
  systemctl restart pveproxy
}

SCRIPT_SRC="/pve2/js/anas.js"

# 1. Remove our line from the template — and only our line. We match on the
#    anas.js source *path* as a substring so the whole tag line is removed
#    regardless of any ?v=<content-hash> cache-bust suffix it carries (story
#    13.15). Removing the whole line (including its newline) leaves the file
#    byte-identical to pristine.
if [ -f "${PVE_TPL}" ] && grep -qF "${SCRIPT_SRC}" "${PVE_TPL}"; then
  tmp="$(mktemp)"
  # \|...|d uses | as the delimiter so the /pve2/js/... slashes need no escaping.
  # The pattern is unanchored, so a trailing ?v=<hash> is inside the matched line
  # and deleted with it.
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

# 4. Reverse-proxy transport (story 12.2): restore the pristine PVE HTTP server
#    module and remove AnasProxy.pm. We only touch AnyEvent.pm if WE patched it
#    (our marker is present) — a pristine file we never modified is left alone.
if [ -f "${PVE_HTTP_SERVER_PM}" ] && grep -qF "${ANAS_HOOK_MARKER}" "${PVE_HTTP_SERVER_PM}"; then
  if [ -f "${PVE_HTTP_SERVER_PM_ORIG}" ]; then
    cp -a "${PVE_HTTP_SERVER_PM_ORIG}" "${PVE_HTTP_SERVER_PM}"
    echo "anas: restored pristine ${PVE_HTTP_SERVER_PM} (from backup)"
  else
    # No backup (unexpected) — surgically excise our additive block by its
    # markers, leaving every other byte of the module intact.
    tmp="$(mktemp)"
    sed "/${ANAS_HOOK_MARKER}/,/${ANAS_HOOK_END}/d" "${PVE_HTTP_SERVER_PM}" > "${tmp}"
    cat "${tmp}" > "${PVE_HTTP_SERVER_PM}"
    rm -f "${tmp}"
    echo "anas: restored ${PVE_HTTP_SERVER_PM} (excised the hook block)"
  fi
  # perl -c the restored (pristine) module before bouncing pveproxy; restart
  # only on pass so a surprise non-compiling module never takes :8006 down.
  if command -v "${PERL_BIN}" >/dev/null 2>&1 && ! "${PERL_BIN}" -c "${PVE_HTTP_SERVER_PM}" >/dev/null 2>&1; then
    echo "anas: WARNING: restored ${PVE_HTTP_SERVER_PM} fails perl -c; NOT restarting pveproxy" >&2
    systemctl reset-failed pveproxy >/dev/null 2>&1 || true
  elif restart_pveproxy; then
    echo "anas: pveproxy restarted (proxy hook removed)"
  else
    echo "anas: WARNING: pveproxy restart failed" >&2
    systemctl reset-failed pveproxy >/dev/null 2>&1 || true
  fi
  # The pristine module is back in place; drop the backup.
  rm -f "${PVE_HTTP_SERVER_PM_ORIG}"
else
  echo "anas: no ANAS proxy hook in ${PVE_HTTP_SERVER_PM} (nothing to restore)"
fi

# 5. Remove the ANAS-owned proxy module (and the dir if we left it empty).
if [ -f "${ANAS_PROXY_PM}" ]; then
  rm -f "${ANAS_PROXY_PM}"
  echo "anas: removed ${ANAS_PROXY_PM}"
  rmdir "${ANAS_PERL_DIR}" 2>/dev/null || true
fi

echo "anas: PVE UI integration uninstalled."
