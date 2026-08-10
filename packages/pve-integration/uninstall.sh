#!/usr/bin/env bash
#
# Uninstall the ANAS PVE web UI integration, restoring the pristine template.
#
# Surgical reverse of install.sh: remove only our <script> line (preserving
# every other byte of index.html.tpl verbatim), remove our JS file, remove our
# proxy hook and module, and remove the apt hook.
#
# COEXISTENCE (issue #20): a sibling project (ADOCK) may be installed on the same
# node with its own hook block in the same PVE module and its own <script> line
# in the same template. Nothing here may touch either.
#
#   * The template edit deletes only lines carrying OUR src (/pve2/js/anas.js).
#   * The module edit prefers SURGICAL marker excision whenever a foreign hook is
#     present, and only falls back to the whole-file .anas-orig restore when the
#     live module carries no other project's block — because a whole-file restore
#     of a file that has since gained a sibling's splice would silently delete it.
#   * Either route builds a CANDIDATE that must pass perl -c before it is adopted,
#     exactly as install.sh gates its patch — removal is not intrinsically safer
#     than addition, and a non-compiling AnyEvent.pm means :8006 is down.
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

# True if $1 carries a third-party proxy-hook block that is NOT ours (issue #20).
# Same definition as install.sh, including the capture-then-match shape that
# keeps `grep | grep -q` out of a pipefail script (issue #21).
has_foreign_hook() {
  local f="$1" markers
  [ -f "${f}" ] || return 1
  markers="$(grep -E '^[[:space:]]*# >>> .+ proxy hook' "${f}" 2>/dev/null || true)"
  [ -n "${markers}" ] || return 1
  grep -qv 'ANAS proxy hook' <<<"${markers}"
}

# Write $1 minus our marker-delimited block to $2, leaving every other byte of
# the module intact — including a sibling project's block. Writes a CANDIDATE
# rather than editing in place: the live module is only overwritten once the
# candidate passes perl -c (same adopt-on-pass discipline as install.sh).
excise_our_hook_to() {
  local f="$1" out="$2"
  sed "/${ANAS_HOOK_MARKER}/,/${ANAS_HOOK_END}/d" "${f}" > "${out}"
}

SCRIPT_SRC="/pve2/js/anas.js"

# 1. Remove our line from the template — and only our line. We match on the
#    anas.js source *path* as a substring so the whole tag line is removed
#    regardless of any ?v=<content-hash> cache-bust suffix it carries (story
#    13.15). Removing the whole line (including its newline) leaves the file
#    byte-identical to pristine. A sibling project's own <script> line carries a
#    different src and is not matched (issue #20).
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

# 4. Reverse-proxy transport (story 12.2): take our hook block out of the PVE
#    HTTP server module and remove AnasProxy.pm. We only touch AnyEvent.pm if WE
#    patched it (our marker is present) — a file we never modified is left alone.
if [ -f "${PVE_HTTP_SERVER_PM}" ] && grep -qF "${ANAS_HOOK_MARKER}" "${PVE_HTTP_SERVER_PM}"; then
  # Build the post-removal module as a CANDIDATE first. Which of the three routes
  # produced it does not change the gate that follows.
  candidate="$(mktemp)"
  if has_foreign_hook "${PVE_HTTP_SERVER_PM}"; then
    # Another project's hook is live in this file. A whole-file restore from our
    # backup would delete it (issue #20) — the backup may well predate the
    # sibling's splice — so excise ONLY our marker block.
    excise_our_hook_to "${PVE_HTTP_SERVER_PM}" "${candidate}"
    removal_desc="excised the ANAS hook block from ${PVE_HTTP_SERVER_PM} (another project's hook is present and was preserved)"
  elif [ -f "${PVE_HTTP_SERVER_PM_ORIG}" ]; then
    cat "${PVE_HTTP_SERVER_PM_ORIG}" > "${candidate}"
    removal_desc="restored pristine ${PVE_HTTP_SERVER_PM} (from backup)"
  else
    # No backup — surgically excise our additive block by its markers, leaving
    # every other byte of the module intact.
    excise_our_hook_to "${PVE_HTTP_SERVER_PM}" "${candidate}"
    removal_desc="restored ${PVE_HTTP_SERVER_PM} (excised the hook block)"
  fi

  # perl -c GATE, mirroring install.sh: adopt ONLY on pass. Removing our block is
  # not intrinsically safer than adding it — a stale whole-file backup or an
  # excision against an unexpected file shape can yield a module that will not
  # compile, and pveproxy would then fail to start on the NEXT boot or package
  # upgrade even though we never restarted it here (=> :8006 DOWN, long after the
  # uninstall). So leave the live module alone and keep our block in place: the
  # hook only affects /anas URLs, which is a far cheaper failure than a dead UI.
  if command -v "${PERL_BIN}" >/dev/null 2>&1 && ! "${PERL_BIN}" -c "${candidate}" >/dev/null 2>&1; then
    rm -f "${candidate}"
    echo "anas: WARNING: removing the hook from ${PVE_HTTP_SERVER_PM} yields a module that fails perl -c." >&2
    echo "anas: WARNING: left the live module and the ANAS hook block UNTOUCHED and did NOT restart pveproxy." >&2
    echo "anas: WARNING: remove the block between '${ANAS_HOOK_MARKER}' and '${ANAS_HOOK_END}' by hand." >&2
    systemctl reset-failed pveproxy >/dev/null 2>&1 || true
  else
    # Gate passed (or no perl to gate with) — adopt. Writing THROUGH the live file
    # keeps its mode and ownership, whichever route built the candidate.
    cat "${candidate}" > "${PVE_HTTP_SERVER_PM}"
    rm -f "${candidate}"
    echo "anas: ${removal_desc}"
    if restart_pveproxy; then
      echo "anas: pveproxy restarted (proxy hook removed)"
    else
      echo "anas: WARNING: pveproxy restart failed" >&2
      systemctl reset-failed pveproxy >/dev/null 2>&1 || true
    fi
    # Our block is gone; drop the backup.
    rm -f "${PVE_HTTP_SERVER_PM_ORIG}"
  fi
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
