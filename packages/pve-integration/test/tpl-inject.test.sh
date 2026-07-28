#!/usr/bin/env bash
#
# Tests for the story-13.15 cache-bust injection in
# packages/pve-integration/{install,uninstall}.sh. The injected <script> tag
# carries a ?v=<content-hash> token computed from the generated anas.js bundle,
# so the browser re-fetches iff the bundle content changes and an upgrade (or a
# same-version dev cut) never serves a stale cached bundle.
#
# Every path is parameterised (PVE_TPL / PVE_JS_DIR / ANAS_SRC_DIR / …), so the
# installer runs end to end against throwaway copies — no real PVE, pveproxy, or
# systemctl involved. The bundle sources are a controllable temp dir so we can
# change the content and observe the token change.
#
#   bash packages/pve-integration/test/tpl-inject.test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "${HERE}/.." && pwd)"
INSTALL="${PKG}/install.sh"
UNINSTALL="${PKG}/uninstall.sh"

PASS=0
FAIL=0
ok()   { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

SCRIPT_SRC="/pve2/js/anas.js"

# A minimal but perl-c-compilable PVE::APIServer::AnyEvent with the exact 4-arg
# handle_api2_request anchor, so the proxy-hook step (install.sh step 3) also
# succeeds and the whole installer exits 0.
make_anyevent() {
  cat > "$1" <<'EOF'
package PVE::APIServer::AnyEvent;
use strict;
use warnings;
sub handle_request {
    my ($self, $reqstate, $auth, $method, $path, $r) = @_;
    if ($path =~ m|^/api2|) {
        $self->handle_api2_request($reqstate, $auth, $method, $path);
        return;
    }
    return;
}
1;
EOF
}

# A throwaway PVE index.html.tpl with the pvemanagerlib.js anchor the tpl step
# keys on, so the injection has somewhere to land.
make_tpl() {
  cat > "$1" <<'EOF'
<html><head>
    <script type="text/javascript" src="/pve2/js/pvemanagerlib.js"></script>
</head><body></body></html>
EOF
}

# A throwaway anas.js source dir (ANAS_SRC_DIR). The installer concatenates
# *.js from here; a valid ES5 statement keeps `node --check` (if node exists)
# happy. $2 is written into the file so callers can vary the bundle content.
make_src() {
  mkdir -p "$1"
  printf 'window.ANAS_TEST = %s;\n' "$2" > "$1/00-test.js"
}

setup_env() {
  WORK="$(mktemp -d)"
  PVE_PM="${WORK}/AnyEvent.pm"
  PERL_DIR="${WORK}/anas-perl"
  TPL="${WORK}/index.html.tpl"
  JS_DIR="${WORK}/js"
  SRC="${WORK}/src"
  HOOK_DIR="${WORK}/apt"
  RESTART_MARK="${WORK}/pveproxy-restarted"
  mkdir -p "${JS_DIR}" "${HOOK_DIR}"
  make_tpl "${TPL}"
  make_anyevent "${PVE_PM}"
  make_src "${SRC}" "1"
}

run_install() {
  PVE_TPL="${TPL}" PVE_JS_DIR="${JS_DIR}" APT_HOOK="${HOOK_DIR}/hook" \
  PVE_HTTP_SERVER_PM="${PVE_PM}" ANAS_PERL_DIR="${PERL_DIR}" \
  ANAS_SRC_DIR="${SRC}" \
  PVEPROXY_RESTART_CMD="touch '${RESTART_MARK}'" \
    bash "${INSTALL}" >"${WORK}/install.log" 2>&1
}

run_uninstall() {
  PVE_TPL="${TPL}" PVE_JS_DIR="${JS_DIR}" APT_HOOK="${HOOK_DIR}/hook" \
  PVE_HTTP_SERVER_PM="${PVE_PM}" ANAS_PERL_DIR="${PERL_DIR}" \
  PVEPROXY_RESTART_CMD="touch '${RESTART_MARK}'" \
    bash "${UNINSTALL}" >"${WORK}/uninstall.log" 2>&1
}

# Echo the ?v= token carried by the (single) anas.js tag line in the tpl.
tpl_token() {
  grep -F "${SCRIPT_SRC}" "${TPL}" \
    | sed -n 's|.*/pve2/js/anas\.js?v=\([0-9a-f]\{1,\}\).*|\1|p'
}

# Echo the expected token: first 12 hex of sha256 of the installed bundle.
expected_token() { sha256sum "${JS_DIR}/anas.js" | cut -c1-12; }

# =============================================================================
echo "== 1. fresh inject: tag carries ?v=<content-hash> =="
setup_env
run_install; rc=$?
tok="$(tpl_token)"
check "install exits 0" "[ ${rc} -eq 0 ]"
check "anas.js tag present in tpl" "grep -qF '${SCRIPT_SRC}' '${TPL}'"
check "tag carries a ?v= token" "[ -n '${tok}' ]"
check "token is 12 hex chars" "printf '%s' '${tok}' | grep -qE '^[0-9a-f]{12}$'"
check "token == sha256(bundle)[:12]" "[ '${tok}' = \"\$(expected_token)\" ]"
check "substring presence-grep still matches (top-level verify)" \
  "grep -qF '/pve2/js/anas.js' '${TPL}'"
check "exactly one anas.js tag line" \
  "[ \"\$(grep -cF '${SCRIPT_SRC}' '${TPL}')\" -eq 1 ]"
rm -rf "${WORK}"

echo "== 2. re-inject, unchanged bundle: same token, still one line =="
setup_env
run_install >/dev/null 2>&1
tok1="$(tpl_token)"
run_install; rc=$?
tok2="$(tpl_token)"
check "second install exits 0" "[ ${rc} -eq 0 ]"
check "token unchanged (idempotent)" "[ '${tok1}' = '${tok2}' ]"
check "still exactly one anas.js tag (no double-insert)" \
  "[ \"\$(grep -cF '${SCRIPT_SRC}' '${TPL}')\" -eq 1 ]"
rm -rf "${WORK}"

echo "== 3. re-inject, CHANGED bundle: new token (upgrade re-stamps) =="
setup_env
run_install >/dev/null 2>&1
tok1="$(tpl_token)"
make_src "${SRC}" "2"          # change the bundle content
run_install; rc=$?
tok2="$(tpl_token)"
check "install exits 0" "[ ${rc} -eq 0 ]"
check "token changed with content" "[ '${tok1}' != '${tok2}' ]"
check "new token == sha256(new bundle)[:12]" "[ '${tok2}' = \"\$(expected_token)\" ]"
check "still exactly one anas.js tag" \
  "[ \"\$(grep -cF '${SCRIPT_SRC}' '${TPL}')\" -eq 1 ]"
rm -rf "${WORK}"

echo "== 4. migrate an UNVERSIONED tag: install re-stamps it with ?v= =="
setup_env
# Simulate a pre-13.15 install: an unversioned anas.js tag already in the tpl.
cat > "${TPL}" <<'EOF'
<html><head>
    <script type="text/javascript" src="/pve2/js/pvemanagerlib.js"></script>
    <script type="text/javascript" src="/pve2/js/anas.js"></script>
</head><body></body></html>
EOF
run_install; rc=$?
tok="$(tpl_token)"
check "install exits 0" "[ ${rc} -eq 0 ]"
check "previously-unversioned tag now carries ?v=" "[ -n '${tok}' ]"
check "token == sha256(bundle)[:12]" "[ '${tok}' = \"\$(expected_token)\" ]"
check "still exactly one anas.js tag" \
  "[ \"\$(grep -cF '${SCRIPT_SRC}' '${TPL}')\" -eq 1 ]"
rm -rf "${WORK}"

echo "== 5. uninstall: versioned tag fully removed, tpl back to pristine =="
setup_env
cp "${TPL}" "${WORK}/tpl.pristine"
run_install >/dev/null 2>&1
check "tag present after install" "grep -qF '${SCRIPT_SRC}' '${TPL}'"
run_uninstall; rc=$?
check "uninstall exits 0" "[ ${rc} -eq 0 ]"
check "no anas.js tag remains (any ?v=)" "! grep -qF '${SCRIPT_SRC}' '${TPL}'"
check "tpl byte-identical to pristine" "cmp -s '${TPL}' '${WORK}/tpl.pristine'"
rm -rf "${WORK}"

echo
echo "tpl-inject tests: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
