#!/usr/bin/env bash
#
# Install the ANAS PVE web UI integration.
#
# ANAS is a *guest* on the Proxmox system (PRINCIPLES.md #12). This installer:
#   1. Drops our own file into /usr/share/pve-manager/js/ (dpkg never removes
#      files it does not own, so it survives pve-manager upgrades).
#   2. Inserts exactly one <script> line into index.html.tpl, immediately after
#      the pvemanagerlib.js line, ONLY if it is not already present. No marker
#      comments, no whole-file overwrite — surgical, idempotent.
#   3. Installs an apt DPkg::Post-Invoke hook that re-runs this installer, so a
#      pve-manager upgrade (which overwrites the template) re-applies the line.
#
# The single fragile point is step 2: pve-manager upgrades overwrite
# index.html.tpl. See README.md.
#
# Paths are parameterised (with production defaults) so the tpl logic can be
# tested against a copy without a real PVE install:
#   PVE_TPL=/tmp/x/index.html.tpl PVE_JS_DIR=/tmp/x/js APT_HOOK=/tmp/x/hook ./install.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PVE_TPL="${PVE_TPL:-/usr/share/pve-manager/index.html.tpl}"
PVE_JS_DIR="${PVE_JS_DIR:-/usr/share/pve-manager/js}"
APT_HOOK="${APT_HOOK:-/etc/apt/apt.conf.d/80anas-pve-integration}"

# --- Reverse-proxy transport (story 12.2, docs/PROXY-TRANSPORT-DESIGN.md) ---
# The :8006 → loopback-gateway bridge: AnasProxy.pm plus one additive hook block
# spliced into PVE's HTTP server module. Paths are parameterised (production
# defaults) so the splice/gate logic can be exercised against copies.
PERL_BIN="${PERL_BIN:-perl}"
PVE_HTTP_SERVER_PM="${PVE_HTTP_SERVER_PM:-/usr/share/perl5/PVE/APIServer/AnyEvent.pm}"
ANAS_PERL_DIR="${ANAS_PERL_DIR:-/usr/share/anas/perl}"
ANAS_PROXY_PM="${ANAS_PERL_DIR}/AnasProxy.pm"
# Pristine backup of the PVE HTTP server module, captured once before we splice.
PVE_HTTP_SERVER_PM_ORIG="${PVE_HTTP_SERVER_PM}.anas-orig"
# Marks our additive block (idempotency check + surgical removal on uninstall).
ANAS_HOOK_MARKER='# >>> ANAS proxy hook'
# Source of the ANAS-owned proxy module, shipped alongside this installer.
PROXY_SRC="${SCRIPT_DIR}/perl/AnasProxy.pm"
# Command that (re)starts pveproxy after a perl-c-verified patch. Overridable so
# the installer tests never touch the real service manager; default is the real
# systemctl sequence.
PVEPROXY_RESTART_CMD="${PVEPROXY_RESTART_CMD:-}"

# The exact <script> source path we inject; the grep presence-check keys on it.
SCRIPT_SRC="/pve2/js/anas.js"
# The full line we insert, matching the template's 4-space indentation.
SCRIPT_TAG='    <script type="text/javascript" src="/pve2/js/anas.js"></script>'

# (Re)start pveproxy so a freshly-patched AnyEvent.pm (new dispatch + a fresh
# require of AnasProxy.pm) takes effect. reset-failed first so a prior failed
# state can't block the restart. Returns non-zero if the restart fails.
restart_pveproxy() {
  if [ -n "${PVEPROXY_RESTART_CMD}" ]; then
    eval "${PVEPROXY_RESTART_CMD}"
    return $?
  fi
  systemctl reset-failed pveproxy >/dev/null 2>&1 || true
  systemctl restart pveproxy
}

# Emit the additive ANAS hook block (tabs match PVE's source; Perl ignores
# indentation, the markers make it findable/removable regardless). The perl
# sigils are escaped so this here-doc only expands the ANAS path/marker vars.
anas_hook_block() {
  cat <<HOOKEOF
	${ANAS_HOOK_MARKER} (additive; restored on uninstall/upgrade-clobber)
	if (\$path =~ m{^/anas(?:/|\$)}) {
	    eval {
		require '${ANAS_PROXY_PM}';
		AnasProxy::handle(\$self, \$reqstate, \$method, \$r->uri);
	    };
	    \$self->error(\$reqstate, 500, 'ANAS proxy error') if \$@;
	    return;
	}
	# <<< ANAS proxy hook
HOOKEOF
}

# Splice the block from $2 into $1 (writing $3) immediately AFTER the closing
# brace of the /api2 dispatch if-block — located by the exact 4-arg
# handle_api2_request anchor, then the first lone `}` that follows it. Never
# inserts anywhere else: with no anchor match nothing is added and the caller
# detects the missing marker and aborts (never force onto a non-match).
splice_proxy_hook() {
  local src="$1" bf="$2" out="$3"
  awk -v bf="${bf}" '
    { print }
    !anas_done && /handle_api2_request\(\$reqstate, \$auth, \$method, \$path\)/ { anas_seen = 1 }
    anas_seen && !anas_done && /^[ \t]*}[ \t]*$/ {
        while ((getline line < bf) > 0) { print line }
        close(bf)
        anas_seen = 0
        anas_done = 1
    }
  ' "${src}" > "${out}"
}

# Install AnasProxy.pm and splice the additive proxy hook into the PVE HTTP
# server module — perl-c-gated, idempotent, fail-open. Returns non-zero on a
# real failure (missing/broken module, anchor mismatch, or a patch that fails
# perl -c); the live PVE module is never left in a non-compiling state.
install_anas_proxy() {
  # 1. Ship AnasProxy.pm (ANAS-owned, upgrade-safe — dpkg doesn't own it).
  if [ ! -f "${PROXY_SRC}" ]; then
    echo "anas: ERROR: proxy module ${PROXY_SRC} not found" >&2
    return 1
  fi
  if command -v "${PERL_BIN}" >/dev/null 2>&1; then
    if ! "${PERL_BIN}" -c "${PROXY_SRC}" >/dev/null 2>&1; then
      echo "anas: ERROR: ${PROXY_SRC} fails perl -c; aborting proxy install" >&2
      return 1
    fi
  fi
  install -D -m 0644 "${PROXY_SRC}" "${ANAS_PROXY_PM}"
  echo "anas: installed ${ANAS_PROXY_PM}"

  # 2. Splice the additive hook into the PVE HTTP server module.
  if [ ! -f "${PVE_HTTP_SERVER_PM}" ]; then
    echo "anas: WARNING: ${PVE_HTTP_SERVER_PM} not found; skipping proxy hook (/anas 404s until present)" >&2
    return 0
  fi
  if grep -qF "${ANAS_HOOK_MARKER}" "${PVE_HTTP_SERVER_PM}"; then
    echo "anas: proxy hook already present in ${PVE_HTTP_SERVER_PM} (nothing to do)"
    return 0
  fi
  # Refuse to force onto a structure we don't recognise (guest philosophy).
  if ! grep -qE 'handle_api2_request\(\$reqstate, \$auth, \$method, \$path\)' "${PVE_HTTP_SERVER_PM}"; then
    echo "anas: ERROR: anchor (4-arg handle_api2_request) not found in ${PVE_HTTP_SERVER_PM}; refusing to patch" >&2
    return 1
  fi

  # Back up the pristine module ONCE.
  if [ ! -f "${PVE_HTTP_SERVER_PM_ORIG}" ]; then
    cp -a "${PVE_HTTP_SERVER_PM}" "${PVE_HTTP_SERVER_PM_ORIG}"
    echo "anas: saved pristine ${PVE_HTTP_SERVER_PM} -> ${PVE_HTTP_SERVER_PM_ORIG}"
  fi

  local blockfile patched
  blockfile="$(mktemp)"
  patched="$(mktemp)"
  anas_hook_block > "${blockfile}"
  # Splice a COPY; the live PVE module is only overwritten once the patch passes
  # perl -c, so a bad splice can never leave :8006 with a non-compiling module.
  splice_proxy_hook "${PVE_HTTP_SERVER_PM}" "${blockfile}" "${patched}"
  rm -f "${blockfile}"

  if ! grep -qF "${ANAS_HOOK_MARKER}" "${patched}"; then
    rm -f "${patched}"
    echo "anas: ERROR: proxy hook splice did not land (anchor mismatch); ${PVE_HTTP_SERVER_PM} untouched" >&2
    return 1
  fi

  # perl -c GATE — the one hazard is a malformed PVE-owned module that won't
  # compile at pveproxy startup (=> :8006 DOWN). Only adopt the patch on pass.
  if command -v "${PERL_BIN}" >/dev/null 2>&1; then
    if ! "${PERL_BIN}" -c "${patched}" >/dev/null 2>&1; then
      rm -f "${patched}"
      # The live module was never overwritten — it is still pristine — so there
      # is nothing to restore. Do NOT restart pveproxy; clear any failed state
      # defensively and abort.
      systemctl reset-failed pveproxy >/dev/null 2>&1 || true
      echo "anas: ERROR: patched ${PVE_HTTP_SERVER_PM} fails perl -c; left the live module pristine, did NOT restart pveproxy" >&2
      return 1
    fi
  else
    echo "anas: note: ${PERL_BIN} not found; skipping perl -c gate on the patched module" >&2
  fi

  # Gate passed — adopt the patched module and reload pveproxy.
  cat "${patched}" > "${PVE_HTTP_SERVER_PM}"
  rm -f "${patched}"
  echo "anas: spliced ANAS proxy hook into ${PVE_HTTP_SERVER_PM}"

  if restart_pveproxy; then
    echo "anas: pveproxy restarted (proxy hook live)"
  else
    echo "anas: WARNING: pveproxy restart failed after patch; the patched module is valid and will load on the next restart" >&2
    systemctl reset-failed pveproxy >/dev/null 2>&1 || true
  fi
  return 0
}

# 1. Generate and install our JS file (our file — upgrade-safe).
#    anas.js is built by concatenating the per-view sources in src/ in lexical
#    order (00-core, 10-api, 20-notinstalled, 30-pools, 40-disks, 50-dashboard,
#    90-register). No build step — plain ES5 files joined verbatim.
SRC_DIR="${SCRIPT_DIR}/src"
if [ ! -d "${SRC_DIR}" ]; then
  echo "anas: ERROR: source dir ${SRC_DIR} not found" >&2
  exit 1
fi
# Resolve the ANAS version to stamp into the bundle (12.1 version-skew checks:
# the UI compares its own build against the gateway/daemon versions). Release
# layout has VERSION two levels up (/opt/anas/VERSION); a dev tree has the root
# package.json there instead. Unresolvable -> no stamp line, checks stay off.
ANAS_VERSION=""
if [ -f "${SCRIPT_DIR}/../../VERSION" ]; then
  ANAS_VERSION="$(cat "${SCRIPT_DIR}/../../VERSION")"
elif command -v node >/dev/null 2>&1 && [ -f "${SCRIPT_DIR}/../../package.json" ]; then
  ANAS_VERSION="$(node -p "require('${SCRIPT_DIR}/../../package.json').version" 2>/dev/null || true)"
  [ "${ANAS_VERSION}" = "undefined" ] && ANAS_VERSION=""
fi

# A .js suffix lets `node --check` (below) infer the file is a plain script;
# without an extension newer node refuses to pick a module format.
gen="$(mktemp --suffix=.js)"
{
  echo "/*"
  echo " * GENERATED FILE — do not edit."
  echo " * Concatenated from packages/pve-integration/src/*.js (lexical order) by"
  echo " * install.sh. Edit the per-view sources in src/ instead."
  echo " */"
  if [ -n "${ANAS_VERSION}" ]; then
    echo "window.ANAS = window.ANAS || {}; window.ANAS.BUILD_VERSION = '${ANAS_VERSION}';"
  fi
  # Bash pathname expansion yields the sources in sorted (numeric-prefix) order.
  for f in "${SRC_DIR}"/*.js; do
    echo ""
    echo "/* ==== $(basename "${f}") ==== */"
    cat "${f}"
  done
} > "${gen}"
# Defensive: refuse to install an empty/failed generation.
if [ ! -s "${gen}" ]; then
  rm -f "${gen}"
  echo "anas: ERROR: generated anas.js is empty" >&2
  exit 1
fi
# Defensive: syntax-check the concatenated bundle before shipping it. A parse
# error in any one src/*.js (they are ESLint-ignored and not checked by the
# build) would make the whole ANAS UI silently vanish in the browser with no
# error surfaced. node is present on the PVE node (the daemon runs on it); skip
# the check if it is not, rather than hard-failing a node-less environment.
if command -v node >/dev/null 2>&1; then
  if ! node --check "${gen}"; then
    rm -f "${gen}"
    echo "anas: ERROR: generated anas.js has a syntax error; aborting install" >&2
    exit 1
  fi
else
  echo "anas: note: node not found; skipping anas.js syntax check" >&2
fi
install -D -m 0644 "${gen}" "${PVE_JS_DIR}/anas.js"
rm -f "${gen}"
echo "anas: installed ${PVE_JS_DIR}/anas.js (generated from src/)"

# 2. Insert the <script> line after pvemanagerlib.js, idempotently.
if [ ! -f "${PVE_TPL}" ]; then
  echo "anas: WARNING: template ${PVE_TPL} not found; skipping tpl injection" >&2
elif grep -qF "${SCRIPT_SRC}" "${PVE_TPL}"; then
  echo "anas: tpl line already present in ${PVE_TPL} (nothing to do)"
elif ! grep -q 'pvemanagerlib\.js' "${PVE_TPL}"; then
  echo "anas: ERROR: no pvemanagerlib.js line in ${PVE_TPL}; refusing to guess" >&2
  exit 1
else
  # Surgical append after ONLY the first pvemanagerlib.js line. awk tracks a
  # done-flag so that a template with more than one pvemanagerlib.js line gets
  # exactly one anas.js tag (a second insert would double-load the bundle and
  # run 00-core/90-register twice). The tag text is passed in verbatim via -v to
  # preserve its leading whitespace. Everything else is passed through untouched.
  tmp="$(mktemp)"
  awk -v tag="${SCRIPT_TAG}" '
    { print }
    !done && /pvemanagerlib\.js/ { print tag; done = 1 }
  ' "${PVE_TPL}" > "${tmp}"
  # Defensive: only replace the real file if the insert actually landed.
  if grep -qF "${SCRIPT_SRC}" "${tmp}"; then
    cat "${tmp}" > "${PVE_TPL}"
    rm -f "${tmp}"
    echo "anas: inserted script line into ${PVE_TPL}"
  else
    rm -f "${tmp}"
    echo "anas: ERROR: failed to insert script line into ${PVE_TPL}" >&2
    exit 1
  fi
fi

# 3. Install the ANAS reverse-proxy transport (AnasProxy.pm + the additive hook
#    in PVE::APIServer::AnyEvent). This bridges pveproxy :8006 → the loopback
#    gateway (story 12.2). Idempotent, perl-c-gated, fail-open. A real failure
#    (broken module, anchor mismatch, or a patch that won't compile) aborts the
#    install with a clear error; the live PVE module is never left broken.
if ! install_anas_proxy; then
  echo "anas: ERROR: proxy transport install failed — see message above" >&2
  exit 1
fi

# 4. Install the apt hook so pve-manager / libpve-http-server-perl upgrades
#    re-apply our patches. DPkg::Post-Invoke runs after every dpkg transaction;
#    the installer is idempotent, so a pve-manager upgrade (which overwrites
#    index.html.tpl) or a libpve-http-server-perl upgrade (which clobbers
#    AnyEvent.pm, dropping the proxy hook) triggers a re-splice with the same
#    perl-c gate. `|| true` keeps a failed re-apply from breaking the apt run.
if [ -d "$(dirname "${APT_HOOK}")" ]; then
  cat > "${APT_HOOK}" <<EOF
// Re-apply the ANAS PVE integration after package changes: pve-manager upgrades
// overwrite /usr/share/pve-manager/index.html.tpl, and libpve-http-server-perl
// upgrades overwrite /usr/share/perl5/PVE/APIServer/AnyEvent.pm (dropping the
// ANAS proxy hook). Installed by ANAS packages/pve-integration/install.sh.
// Idempotent; the re-splice is perl-c-gated so a bad patch never breaks :8006.
DPkg::Post-Invoke { "if [ -x ${SCRIPT_DIR}/install.sh ]; then ${SCRIPT_DIR}/install.sh || true; fi"; };
EOF
  echo "anas: installed apt hook ${APT_HOOK}"
else
  echo "anas: WARNING: $(dirname "${APT_HOOK}") missing; skipping apt hook" >&2
fi

echo "anas: PVE UI integration installed."
