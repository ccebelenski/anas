#!/usr/bin/env bash
#
# Tests for the story-12.2 reverse-proxy install machinery in
# packages/pve-integration/{install,uninstall}.sh. Modeled on the tpl-injection
# design: every path is parameterised, so the splice + perl-c gate run against
# throwaway copies with no real PVE, pveproxy, or systemctl involved.
#
# Covers: AnasProxy.pm ships, the additive hook is spliced only on an exact
# anchor match, idempotency, the perl-c gate aborts (leaving the live module
# pristine) on a bad patch, and uninstall restores the byte-pristine module.
#
#   bash packages/pve-integration/test/proxy-install.test.sh
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

MARKER='# >>> ANAS proxy hook'

# A minimal but perl-c-compilable stand-in for PVE::APIServer::AnyEvent with the
# exact 4-arg handle_api2_request anchor and the lone closing brace after it.
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

# Same module WITHOUT the anchor (a hypothetical restructured PVE).
make_anyevent_noanchor() {
  cat > "$1" <<'EOF'
package PVE::APIServer::AnyEvent;
use strict;
use warnings;
sub handle_request {
    my ($self, $reqstate, $auth, $method, $path, $r) = @_;
    $self->dispatch_somehow($reqstate, $path);
    return;
}
1;
EOF
}

# A throwaway PVE index.html.tpl with the pvemanagerlib.js anchor the tpl step
# needs, so the whole installer runs to completion.
make_tpl() {
  cat > "$1" <<'EOF'
<html><head>
    <script type="text/javascript" src="/pve2/js/pvemanagerlib.js"></script>
</head><body></body></html>
EOF
}

# Build a scratch environment; echoes the workdir. Sets globals used by callers.
setup_env() {
  WORK="$(mktemp -d)"
  PVE_PM="${WORK}/AnyEvent.pm"
  PRISTINE="${WORK}/AnyEvent.pristine.pm"
  PERL_DIR="${WORK}/anas-perl"
  TPL="${WORK}/index.html.tpl"
  JS_DIR="${WORK}/js"
  HOOK_DIR="${WORK}/apt"
  RESTART_MARK="${WORK}/pveproxy-restarted"
  mkdir -p "${JS_DIR}" "${HOOK_DIR}"
  make_tpl "${TPL}"
}

run_install() {
  # PERL_BIN must be a LITERAL assignment word here — a value produced by an
  # expansion (e.g. ${x:+PERL_BIN=…}) is NOT recognised as an env prefix and
  # would be run as a command instead. Default to the real perl.
  PVE_TPL="${TPL}" PVE_JS_DIR="${JS_DIR}" APT_HOOK="${HOOK_DIR}/hook" \
  PVE_HTTP_SERVER_PM="${PVE_PM}" ANAS_PERL_DIR="${PERL_DIR}" \
  PVEPROXY_RESTART_CMD="touch '${RESTART_MARK}'" \
  PERL_BIN="${PERL_BIN_OVERRIDE:-perl}" \
    bash "${INSTALL}" >"${WORK}/install.log" 2>&1
}

run_uninstall() {
  PVE_TPL="${TPL}" PVE_JS_DIR="${JS_DIR}" APT_HOOK="${HOOK_DIR}/hook" \
  PVE_HTTP_SERVER_PM="${PVE_PM}" ANAS_PERL_DIR="${PERL_DIR}" \
  PVEPROXY_RESTART_CMD="touch '${RESTART_MARK}'" \
    bash "${UNINSTALL}" >"${WORK}/uninstall.log" 2>&1
}

# =============================================================================
echo "== 1. happy path: ships module, splices hook, backs up, restarts =="
setup_env
make_anyevent "${PVE_PM}"
cp "${PVE_PM}" "${PRISTINE}"
PERL_BIN_OVERRIDE="" run_install; rc=$?
check "install exits 0" "[ ${rc} -eq 0 ]"
check "AnasProxy.pm installed" "[ -f '${PERL_DIR}/AnasProxy.pm' ]"
check "hook marker spliced in" "grep -qF '${MARKER}' '${PVE_PM}'"
check "pristine backup captured" "[ -f '${PVE_PM}.anas-orig' ]"
check "backup is byte-pristine" "cmp -s '${PVE_PM}.anas-orig' '${PRISTINE}'"
check "patched module compiles" "perl -c '${PVE_PM}' >/dev/null 2>&1"
check "pveproxy restart invoked" "[ -f '${RESTART_MARK}' ]"
check "AnasProxy require path points at ANAS_PERL_DIR" \
  "grep -qF \"require '${PERL_DIR}/AnasProxy.pm'\" '${PVE_PM}'"
rm -rf "${WORK}"

echo "== 2. idempotency: second install is a no-op on the module =="
setup_env
make_anyevent "${PVE_PM}"
PERL_BIN_OVERRIDE="" run_install >/dev/null 2>&1
count1="$(grep -cF "${MARKER}" "${PVE_PM}")"
rm -f "${RESTART_MARK}"
PERL_BIN_OVERRIDE="" run_install; rc=$?
count2="$(grep -cF "${MARKER}" "${PVE_PM}")"
check "second install exits 0" "[ ${rc} -eq 0 ]"
check "exactly one hook block after first install" "[ '${count1}' -eq 1 ]"
check "still exactly one hook block (no double-insert)" "[ '${count2}' -eq 1 ]"
check "no pveproxy restart on the idempotent no-op" "[ ! -f '${RESTART_MARK}' ]"
rm -rf "${WORK}"

echo "== 3. anchor required: no anchor => refuse, leave module untouched =="
setup_env
make_anyevent_noanchor "${PVE_PM}"
cp "${PVE_PM}" "${PRISTINE}"
PERL_BIN_OVERRIDE="" run_install; rc=$?
check "install exits non-zero" "[ ${rc} -ne 0 ]"
check "no hook marker added" "! grep -qF '${MARKER}' '${PVE_PM}'"
check "module left byte-identical" "cmp -s '${PVE_PM}' '${PRISTINE}'"
check "error names the missing anchor" "grep -qi 'anchor' '${WORK}/install.log'"
rm -rf "${WORK}"

echo "== 4. perl-c gate: bad patch aborts, live module stays pristine =="
setup_env
make_anyevent "${PVE_PM}"
cp "${PVE_PM}" "${PRISTINE}"
# Fake perl: pass -c for the AnasProxy module (step 1), FAIL for the patched
# AnyEvent.pm (the gate) — isolating the post-splice gate path.
FAKE_PERL="${WORK}/fake-perl"
cat > "${FAKE_PERL}" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "-c" ]; then
  case "$2" in
    *AnasProxy*) exit 0 ;;
    *) echo "fake perl: syntax error" >&2; exit 1 ;;
  esac
fi
exec perl "$@"
EOF
chmod +x "${FAKE_PERL}"
PERL_BIN_OVERRIDE="${FAKE_PERL}" run_install; rc=$?
check "install exits non-zero" "[ ${rc} -ne 0 ]"
check "live module NOT patched (still pristine)" "cmp -s '${PVE_PM}' '${PRISTINE}'"
check "no hook marker in live module" "! grep -qF '${MARKER}' '${PVE_PM}'"
check "pveproxy NOT restarted" "[ ! -f '${RESTART_MARK}' ]"
check "error mentions perl -c" "grep -qi 'perl -c' '${WORK}/install.log'"
rm -rf "${WORK}"

echo "== 5. uninstall restores the byte-pristine module and removes the pm =="
setup_env
make_anyevent "${PVE_PM}"
cp "${PVE_PM}" "${PRISTINE}"
PERL_BIN_OVERRIDE="" run_install >/dev/null 2>&1
rm -f "${RESTART_MARK}"
run_uninstall; rc=$?
check "uninstall exits 0" "[ ${rc} -eq 0 ]"
check "module restored byte-pristine" "cmp -s '${PVE_PM}' '${PRISTINE}'"
check "AnasProxy.pm removed" "[ ! -f '${PERL_DIR}/AnasProxy.pm' ]"
check "backup removed after restore" "[ ! -f '${PVE_PM}.anas-orig' ]"
check "pveproxy restart invoked on uninstall" "[ -f '${RESTART_MARK}' ]"
rm -rf "${WORK}"

echo "== 6. uninstall leaves a pristine (unpatched) module alone =="
setup_env
make_anyevent "${PVE_PM}"
cp "${PVE_PM}" "${PRISTINE}"
run_uninstall; rc=$?
check "uninstall exits 0" "[ ${rc} -eq 0 ]"
check "unpatched module untouched" "cmp -s '${PVE_PM}' '${PRISTINE}'"
check "no restart for a file we never patched" "[ ! -f '${RESTART_MARK}' ]"
rm -rf "${WORK}"

echo
echo "proxy-install tests: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
