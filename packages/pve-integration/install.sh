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

# The exact <script> source path we inject; the grep presence-check keys on it.
SCRIPT_SRC="/pve2/js/anas.js"
# The full line we insert, matching the template's 4-space indentation.
SCRIPT_TAG='    <script type="text/javascript" src="/pve2/js/anas.js"></script>'

# 1. Generate and install our JS file (our file — upgrade-safe).
#    anas.js is built by concatenating the per-view sources in src/ in lexical
#    order (00-core, 10-api, 20-notinstalled, 30-pools, 40-disks, 50-dashboard,
#    90-register). No build step — plain ES5 files joined verbatim.
SRC_DIR="${SCRIPT_DIR}/src"
if [ ! -d "${SRC_DIR}" ]; then
  echo "anas: ERROR: source dir ${SRC_DIR} not found" >&2
  exit 1
fi
gen="$(mktemp)"
{
  echo "/*"
  echo " * GENERATED FILE — do not edit."
  echo " * Concatenated from packages/pve-integration/src/*.js (lexical order) by"
  echo " * install.sh. Edit the per-view sources in src/ instead."
  echo " */"
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
  # Surgical append after the first pvemanagerlib.js line. The `a\<newline>TAG`
  # form preserves the tag's leading whitespace verbatim. Everything else in the
  # file is passed through untouched.
  tmp="$(mktemp)"
  sed "\|pvemanagerlib\.js|a\\
${SCRIPT_TAG}" "${PVE_TPL}" > "${tmp}"
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

# 3. Install the apt hook so pve-manager upgrades re-apply the tpl line.
#    DPkg::Post-Invoke runs after every dpkg transaction; the installer is
#    idempotent, so re-running is cheap and safe. `|| true` keeps a failed
#    re-apply from breaking the user's apt run.
if [ -d "$(dirname "${APT_HOOK}")" ]; then
  cat > "${APT_HOOK}" <<EOF
// Re-apply the ANAS PVE UI integration after package changes (pve-manager
// upgrades overwrite /usr/share/pve-manager/index.html.tpl). Installed by
// ANAS packages/pve-integration/install.sh. Idempotent.
DPkg::Post-Invoke { "if [ -x ${SCRIPT_DIR}/install.sh ]; then ${SCRIPT_DIR}/install.sh || true; fi"; };
EOF
  echo "anas: installed apt hook ${APT_HOOK}"
else
  echo "anas: WARNING: $(dirname "${APT_HOOK}") missing; skipping apt hook" >&2
fi

echo "anas: PVE UI integration installed."
