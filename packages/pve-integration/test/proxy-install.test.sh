#!/usr/bin/env bash
#
# Tests for the story-12.2 reverse-proxy install machinery in
# packages/pve-integration/{install,uninstall}.sh. Modeled on the tpl-injection
# design: every path is parameterised, so the splice + perl-c gate run against
# throwaway copies with no real PVE, pveproxy, or systemctl involved.
#
# Covers: AnasProxy.pm ships, the additive hook is spliced only on an exact
# anchor match, idempotency, the perl-c gate aborts (leaving the live module
# pristine) on a bad patch, uninstall restores the byte-pristine module by
# MARKER EXCISION (never from a whole-file copy, review H2) — and the
# SIBLING-PROJECT COEXISTENCE requirement (issue #20) in both install orders: a
# foreign hook block in the same module survives our install and our uninstall.
# Review H2 specifically: after a package upgrade swaps in a new module and the
# apt hook re-splices it, the uninstall must restore the NEW module byte-for-
# byte, and a stale .anas-orig left by an older install is swept, never used.
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
# A sibling project's marker — ADOCK today, but the code keys on "any '# >>> …
# proxy hook' that is not ours", so this stands in for any of them (issue #20).
ADOCK_MARKER='# >>> ADOCK proxy hook'

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

# The same module with a SIBLING's hook block already spliced in — byte-shaped
# exactly as ADOCK's installer emits it (tab indent, its own markers, its own
# path guard). This is the "sibling installed first" starting state (issue #20).
make_anyevent_with_adock() {
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
	# >>> ADOCK proxy hook (additive; restored on uninstall/upgrade-clobber)
	if ($path =~ m{^/adock(?:/|$)}) {
	    eval {
		require '/usr/share/adock/perl/AdockProxy.pm';
		AdockProxy::handle($self, $reqstate, $method, $r->uri);
	    };
	    $self->error($reqstate, 500, 'ADOCK proxy error') if $@;
	    return;
	}
	# <<< ADOCK proxy hook
    return;
}
1;
EOF
}

# Write a sibling-shaped hook block to $1, for splicing into an already-patched
# module with the sibling's own (identically shaped) splice algorithm.
make_adock_block() {
  cat > "$1" <<'EOF'
	# >>> ADOCK proxy hook (additive; restored on uninstall/upgrade-clobber)
	if ($path =~ m{^/adock(?:/|$)}) {
	    eval {
		require '/usr/share/adock/perl/AdockProxy.pm';
		AdockProxy::handle($self, $reqstate, $method, $r->uri);
	    };
	    $self->error($reqstate, 500, 'ADOCK proxy error') if $@;
	    return;
	}
	# <<< ADOCK proxy hook
EOF
}

# Splice the block in $2 into the module $1 (in place) using the SIBLING's own
# algorithm — the same anchor + first-lone-brace rule our installer uses, which
# is exactly what makes the two splices additive in either order.
splice_as_sibling() {
  local pm="$1" bf="$2" out
  out="$(mktemp)"
  awk -v bf="${bf}" '
    { print }
    !sib_done && /handle_api2_request\(\$reqstate, \$auth, \$method, \$path\)/ { sib_seen = 1 }
    sib_seen && !sib_done && /^[ \t]*}[ \t]*$/ {
        while ((getline line < bf) > 0) { print line }
        close(bf)
        sib_seen = 0
        sib_done = 1
    }
  ' "${pm}" > "${out}"
  cat "${out}" > "${pm}"
  rm -f "${out}"
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

# The same template with a sibling project's <script> line already present.
make_tpl_with_adock() {
  cat > "$1" <<'EOF'
<html><head>
    <script type="text/javascript" src="/pve2/js/pvemanagerlib.js"></script>
    <script type="text/javascript" src="/pve2/js/adock.js?v=abc123abc123"></script>
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
  RELOAD_MARK="${WORK}/pveproxy-reloaded"
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
  PVEPROXY_RELOAD_CMD="touch '${RELOAD_MARK}'" \
  PERL_BIN="${PERL_BIN_OVERRIDE:-perl}" \
    bash "${INSTALL}" >"${WORK}/install.log" 2>&1
}

run_uninstall() {
  # Same literal-assignment rule as run_install; PERL_BIN_OVERRIDE lets a test
  # drive the uninstall-side perl -c gate.
  PVE_TPL="${TPL}" PVE_JS_DIR="${JS_DIR}" APT_HOOK="${HOOK_DIR}/hook" \
  PVE_HTTP_SERVER_PM="${PVE_PM}" ANAS_PERL_DIR="${PERL_DIR}" \
  PVEPROXY_RESTART_CMD="touch '${RESTART_MARK}'" \
  PERL_BIN="${PERL_BIN_OVERRIDE:-perl}" \
    bash "${UNINSTALL}" >"${WORK}/uninstall.log" 2>&1
}

# =============================================================================
echo "== 1. happy path: ships module, splices hook, takes no backup, restarts =="
setup_env
make_anyevent "${PVE_PM}"
cp "${PVE_PM}" "${PRISTINE}"
PERL_BIN_OVERRIDE="" run_install; rc=$?
check "install exits 0" "[ ${rc} -eq 0 ]"
check "AnasProxy.pm installed" "[ -f '${PERL_DIR}/AnasProxy.pm' ]"
check "hook marker spliced in" "grep -qF '${MARKER}' '${PVE_PM}'"
check "no whole-file backup captured (review H2)" "[ ! -f '${PVE_PM}.anas-orig' ]"
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
check "no pveproxy reload when AnasProxy.pm is unchanged (cr.27)" "[ ! -f '${RELOAD_MARK}' ]"
rm -rf "${WORK}"

echo "== 2b. cr.27 (F12): an upgrade that only changes AnasProxy.pm reloads pveproxy =="
setup_env
make_anyevent "${PVE_PM}"
PERL_BIN_OVERRIDE="" run_install >/dev/null 2>&1
cp "${PVE_PM}" "${WORK}/spliced.pm"
# The node runs an older module than the one this install ships.
printf '# an older AnasProxy.pm\n' >> "${PERL_DIR}/AnasProxy.pm"
rm -f "${RESTART_MARK}" "${RELOAD_MARK}"
PERL_BIN_OVERRIDE="" run_install; rc=$?
check "upgrade install exits 0" "[ ${rc} -eq 0 ]"
check "the shipped module replaced the old one" "cmp -s '${PKG}/perl/AnasProxy.pm' '${PERL_DIR}/AnasProxy.pm'"
check "pveproxy reload requested (workers drop the cached module)" "[ -f '${RELOAD_MARK}' ]"
check "no restart (the hook was already spliced)" "[ ! -f '${RESTART_MARK}' ]"
check "the PVE module is not touched" "cmp -s '${PVE_PM}' '${WORK}/spliced.pm'"
check "install log says why" "grep -q 'AnasProxy.pm changed, pveproxy reloaded' '${WORK}/install.log'"
rm -rf "${WORK}"

echo "== 2c. cr.27 (F12): a failed reload warns with the manual step and does not fail the install =="
setup_env
make_anyevent "${PVE_PM}"
PERL_BIN_OVERRIDE="" run_install >/dev/null 2>&1
printf '# an older AnasProxy.pm\n' >> "${PERL_DIR}/AnasProxy.pm"
PVE_TPL="${TPL}" PVE_JS_DIR="${JS_DIR}" APT_HOOK="${HOOK_DIR}/hook" \
PVE_HTTP_SERVER_PM="${PVE_PM}" ANAS_PERL_DIR="${PERL_DIR}" \
PVEPROXY_RESTART_CMD="touch '${RESTART_MARK}'" \
PVEPROXY_RELOAD_CMD="false" \
  bash "${INSTALL}" >"${WORK}/install.log" 2>&1; rc=$?
check "install still exits 0" "[ ${rc} -eq 0 ]"
check "the warning names the manual reload" "grep -qF \"run 'systemctl reload pveproxy'\" '${WORK}/install.log'"
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
check "no .anas-orig after uninstall (none captured, none left)" "[ ! -f '${PVE_PM}.anas-orig' ]"
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

# =============================================================================
# SIBLING-PROJECT COEXISTENCE (issue #20). A second project (ADOCK) splices its
# own hook block into the same PVE module using the same additive convention.
# Neither install order may cost the other its hook — which is one of the two
# reasons removal is ALWAYS surgical marker excision and we never keep a
# whole-file copy of PVE's module to restore (issue #20, review H2).
# =============================================================================

echo "== 7. SIBLING FIRST: ANAS splices additively, preserving the foreign hook =="
setup_env
make_anyevent_with_adock "${PVE_PM}"
make_tpl_with_adock "${TPL}"
ADOCK_BEFORE="${WORK}/adock-block-before"
grep -A8 -F "${ADOCK_MARKER}" "${PVE_PM}" > "${ADOCK_BEFORE}"
PERL_BIN_OVERRIDE="" run_install; rc=$?
check "install exits 0 with a foreign hook already spliced" "[ ${rc} -eq 0 ]"
check "ANAS hook present" "grep -qF '${MARKER}' '${PVE_PM}'"
check "foreign hook STILL present" "grep -qF '${ADOCK_MARKER}' '${PVE_PM}'"
check "foreign block byte-unchanged" \
  "grep -A8 -F '${ADOCK_MARKER}' '${PVE_PM}' | cmp -s - '${ADOCK_BEFORE}'"
check "both path guards live in the module" \
  "grep -qF 'm{^/anas(?:/|\$)}' '${PVE_PM}' && grep -qF 'm{^/adock(?:/|\$)}' '${PVE_PM}'"
check "foreign require line untouched" \
  "grep -qF \"require '/usr/share/adock/perl/AdockProxy.pm'\" '${PVE_PM}'"
check "dual-spliced module compiles" "perl -c '${PVE_PM}' >/dev/null 2>&1"
check "NO whole-file backup taken (nothing is ever restored from a copy)" \
  "[ ! -f '${PVE_PM}.anas-orig' ]"
check "install log notes the ADDITIVE splice alongside the foreign hook" \
  "grep -qi \"another project's proxy hook\" '${WORK}/install.log'"
check "foreign script tag preserved in the template" \
  "grep -qF '/pve2/js/adock.js' '${TPL}'"
check "ANAS script tag added to the template" \
  "grep -qF '/pve2/js/anas.js' '${TPL}'"
rm -rf "${WORK}"

echo "== 8. SIBLING FIRST: ANAS uninstall excises only its own block =="
setup_env
make_anyevent_with_adock "${PVE_PM}"
make_tpl_with_adock "${TPL}"
cp "${PVE_PM}" "${PRISTINE}"     # 'pristine' here = sibling-only state
PERL_BIN_OVERRIDE="" run_install >/dev/null 2>&1
rm -f "${RESTART_MARK}"
run_uninstall; rc=$?
check "uninstall exits 0" "[ ${rc} -eq 0 ]"
check "ANAS hook gone" "! grep -qF '${MARKER}' '${PVE_PM}'"
check "foreign hook survived the ANAS uninstall" "grep -qF '${ADOCK_MARKER}' '${PVE_PM}'"
check "module is byte-identical to the sibling-only state" "cmp -s '${PVE_PM}' '${PRISTINE}'"
check "module still compiles" "perl -c '${PVE_PM}' >/dev/null 2>&1"
check "uninstall log names the preserved foreign hook" \
  "grep -qi \"another project's hook is present\" '${WORK}/uninstall.log'"
check "foreign script tag survived" "grep -qF '/pve2/js/adock.js' '${TPL}'"
check "ANAS script tag removed" "! grep -qF '/pve2/js/anas.js' '${TPL}'"
check "AnasProxy.pm removed" "[ ! -f '${PERL_DIR}/AnasProxy.pm' ]"
rm -rf "${WORK}"

echo "== 9. ANAS FIRST: a sibling's second splice lands beside ours =="
# ANAS installs into a pristine module; then a sibling-shaped block is spliced in
# with the same anchor + first-lone-brace rule, proving the reverse install order
# is additive too.
setup_env
make_anyevent "${PVE_PM}"
PERL_BIN_OVERRIDE="" run_install >/dev/null 2>&1
check "ANAS hook present after the first install" "grep -qF '${MARKER}' '${PVE_PM}'"
make_adock_block "${WORK}/adock-block"
splice_as_sibling "${PVE_PM}" "${WORK}/adock-block"
check "the sibling's splice landed its block" "grep -qF '${ADOCK_MARKER}' '${PVE_PM}'"
check "ANAS hook survived the sibling's splice" "grep -qF '${MARKER}' '${PVE_PM}'"
check "exactly one ANAS block" "[ \"\$(grep -cF '${MARKER}' '${PVE_PM}')\" = '1' ]"
check "exactly one foreign block" "[ \"\$(grep -cF '${ADOCK_MARKER}' '${PVE_PM}')\" = '1' ]"
check "dual-spliced module compiles (reverse order)" "perl -c '${PVE_PM}' >/dev/null 2>&1"
# A re-run of our installer over the dual state stays a no-op.
rm -f "${RESTART_MARK}"
PERL_BIN_OVERRIDE="" run_install; rc=$?
check "ANAS re-install over the dual state exits 0" "[ ${rc} -eq 0 ]"
check "still exactly one ANAS block" "[ \"\$(grep -cF '${MARKER}' '${PVE_PM}')\" = '1' ]"
check "still exactly one foreign block" "[ \"\$(grep -cF '${ADOCK_MARKER}' '${PVE_PM}')\" = '1' ]"
check "no restart on the idempotent re-run" "[ ! -f '${RESTART_MARK}' ]"
rm -rf "${WORK}"

echo "== 10. ANAS FIRST then sibling: uninstall must not use a stale backup =="
setup_env
make_anyevent "${PVE_PM}"
PERL_BIN_OVERRIDE="" run_install >/dev/null 2>&1
check "install takes no whole-file backup" "[ ! -f '${PVE_PM}.anas-orig' ]"
make_adock_block "${WORK}/adock-block"
splice_as_sibling "${PVE_PM}" "${WORK}/adock-block"
# THE TRAP (review H2 shape): a .anas-orig from an older ANAS predates both
# the sibling's splice and any module change. A whole-file restore would
# silently delete the sibling's hook. Uninstall excises surgically by marker
# regardless, and removes the stale copy instead of using it.
printf 'STALE BACKUP CONTENTS\n' > "${PVE_PM}.anas-orig"
run_uninstall; rc=$?
check "uninstall exits 0" "[ ${rc} -eq 0 ]"
check "ANAS hook gone" "! grep -qF '${MARKER}' '${PVE_PM}'"
check "foreign hook NOT clobbered by the stale whole-file backup" \
  "grep -qF '${ADOCK_MARKER}' '${PVE_PM}'"
check "module still compiles" "perl -c '${PVE_PM}' >/dev/null 2>&1"
check "stale backup dropped" "[ ! -f '${PVE_PM}.anas-orig' ]"
check "module is the excision, not the stale contents" \
  "! grep -qF 'STALE BACKUP CONTENTS' '${PVE_PM}'"
rm -rf "${WORK}"

echo "== 11. uninstall perl-c gate: a non-compiling removal is NOT adopted =="
# Removal is not intrinsically safer than addition: an excision against an
# unexpected file shape can yield a module pveproxy cannot — and it would fail on the NEXT boot, long after the uninstall. So the
# uninstall gates its candidate exactly as the install gates its patch: adopt
# only on pass, otherwise leave the live module (and our block) alone.
setup_env
make_anyevent_with_adock "${PVE_PM}"
PERL_BIN_OVERRIDE="" run_install >/dev/null 2>&1
cp "${PVE_PM}" "${PRISTINE}"     # the live dual-hook state, which must survive
rm -f "${RESTART_MARK}"
FAKE_PERL="${WORK}/fake-perl"
cat > "${FAKE_PERL}" <<'EOF'
#!/usr/bin/env bash
# Fail -c for everything: the uninstall's only -c is the removal candidate.
[ "$1" = "-c" ] && { echo "fake perl: syntax error" >&2; exit 1; }
exec perl "$@"
EOF
chmod +x "${FAKE_PERL}"
PERL_BIN_OVERRIDE="${FAKE_PERL}" run_uninstall; rc=$?
check "uninstall exits 0 (fail-open, not a hard error)" "[ ${rc} -eq 0 ]"
check "live module left byte-untouched" "cmp -s '${PVE_PM}' '${PRISTINE}'"
check "ANAS block deliberately still present" "grep -qF '${MARKER}' '${PVE_PM}'"
check "foreign block still present" "grep -qF '${ADOCK_MARKER}' '${PVE_PM}'"
check "pveproxy NOT restarted" "[ ! -f '${RESTART_MARK}' ]"
check "warning names perl -c" "grep -qi 'perl -c' '${WORK}/uninstall.log'"
check "warning tells the operator how to finish by hand" \
  "grep -qi 'by hand' '${WORK}/uninstall.log'"
rm -rf "${WORK}"

echo "== 12. apt hook line: runs the logging wrapper, never fails apt (installer.1) =="
# The hook's BODY (journald lines, the notification) is apt-reapply.test.sh's
# job; this pins the LINE the real installer writes, and runs it the way apt
# does (`sh -c <string>`) against a staged copy of the directory, so a failing
# wrapper and an absent one are both proven to leave the apt run successful.
setup_env
make_anyevent "${PVE_PM}"
PERL_BIN_OVERRIDE="" run_install; rc=$?
HOOK="${HOOK_DIR}/hook"
check "install exits 0" "[ ${rc} -eq 0 ]"
check "exactly one DPkg::Post-Invoke line" "[ \"\$(grep -c 'DPkg::Post-Invoke' '${HOOK}')\" = '1' ]"
HOOK_CMD="$(sed -n 's/^DPkg::Post-Invoke { "\(.*\)"; };$/\1/p' "${HOOK}")"
check "the line is one quoted apt string (no inner double quote)" \
  "[ -n \"\${HOOK_CMD}\" ] && [ \"\${HOOK_CMD}\" = \"\${HOOK_CMD//\\\"/}\" ]"
check "the line is exactly the [ -x ] gate, the wrapper and || true" \
  "[ \"\${HOOK_CMD}\" = 'if [ -x ${PKG}/apt-reapply.sh ]; then ${PKG}/apt-reapply.sh || true; fi' ]"
check "the wrapper it names ships executable beside install.sh" "[ -x '${PKG}/apt-reapply.sh' ]"
check "the hook comment points at the journald tag" "grep -qF 'journalctl -t anas-pve-integration' '${HOOK}'"
if command -v apt-config >/dev/null 2>&1; then
  check "apt-config parses the hook file" \
    "apt-config -c '${HOOK}' dump 2>/dev/null | grep -qF 'DPkg::Post-Invoke'"
fi
# Run the line as apt would, retargeted at a staged directory.
STAGE="${WORK}/stage"
mkdir -p "${STAGE}"
STAGED_CMD="${HOOK_CMD//${PKG}/${STAGE}}"
printf '#!/bin/sh\ntouch "%s/wrapper-ran"\nexit 7\n' "${WORK}" > "${STAGE}/apt-reapply.sh"
chmod +x "${STAGE}/apt-reapply.sh"
sh -c "${STAGED_CMD}" >/dev/null 2>&1; rc=$?
check "a wrapper exiting 7 still leaves the hook at exit 0" "[ ${rc} -eq 0 ]"
check "the wrapper did run" "[ -f '${WORK}/wrapper-ran' ]"
rm -f "${STAGE}/apt-reapply.sh" "${WORK}/wrapper-ran"
sh -c "${STAGED_CMD}" >"${WORK}/hook.out" 2>&1; rc=$?
check "ANAS gone (no wrapper): the hook is a silent no-op at exit 0" \
  "[ ${rc} -eq 0 ] && [ ! -s '${WORK}/hook.out' ]"
rm -rf "${WORK}"

echo "== 13. no wrapper beside install.sh: refused before anything is touched =="
setup_env
make_anyevent "${PVE_PM}"
cp "${PVE_PM}" "${PRISTINE}"
cp "${TPL}" "${WORK}/tpl.pristine"
NOWRAP="${WORK}/pkg-nowrap"
mkdir -p "${NOWRAP}"
cp -a "${PKG}/install.sh" "${PKG}/src" "${PKG}/perl" "${NOWRAP}/"
PVE_TPL="${TPL}" PVE_JS_DIR="${JS_DIR}" APT_HOOK="${HOOK_DIR}/hook" \
PVE_HTTP_SERVER_PM="${PVE_PM}" ANAS_PERL_DIR="${PERL_DIR}" \
PVEPROXY_RESTART_CMD="touch '${RESTART_MARK}'" PERL_BIN=perl \
  bash "${NOWRAP}/install.sh" >"${WORK}/install.log" 2>&1; rc=$?
check "install exits non-zero" "[ ${rc} -ne 0 ]"
check "error names the missing wrapper" "grep -qF 'apt-reapply.sh not found' '${WORK}/install.log'"
check "no apt hook written" "[ ! -e '${HOOK_DIR}/hook' ]"
check "template untouched" "cmp -s '${TPL}' '${WORK}/tpl.pristine'"
check "PVE module untouched" "cmp -s '${PVE_PM}' '${PRISTINE}'"
rm -rf "${WORK}"

# =============================================================================
# REVIEW H2: uninstall must never roll PVE's module back to a stale copy.
# Removal is always marker excision, so what comes out the far side is whatever
# the package installed — never a snapshot ANAS took at install time.
# =============================================================================

echo "== 14. package upgrade: uninstall restores the NEW module, not the old one =="
setup_env
make_anyevent "${PVE_PM}"                       # module v1 (pre-upgrade)
V1="${WORK}/AnyEvent.v1.pm"
V2="${WORK}/AnyEvent.v2.pm"
cp "${PVE_PM}" "${V1}"
# v2 = the module after a libpve-http-server-perl upgrade: upstream added a
# line. It compiles fine, which is exactly why the perl -c gate alone could
# never detect the silent downgrade.
sed '2i # upstream: libpve-http-server-perl 8.4.0 changelog note' "${V1}" > "${V2}"
PERL_BIN_OVERRIDE="" run_install >/dev/null 2>&1
check "hook spliced into v1" "grep -qF '${MARKER}' '${PVE_PM}'"
check "no backup captured on the v1 install" "[ ! -f '${PVE_PM}.anas-orig' ]"
# The upgrade: dpkg rewrites the module — our hook is gone, v2 is live.
cp "${V2}" "${PVE_PM}"
# The apt hook re-runs install.sh, which re-splices the NEW module.
PERL_BIN_OVERRIDE="" run_install; rc=$?
check "re-install onto the upgraded module exits 0" "[ ${rc} -eq 0 ]"
check "hook re-spliced into v2" "grep -qF '${MARKER}' '${PVE_PM}'"
check "v2's upstream line present" "grep -qF 'libpve-http-server-perl 8.4.0' '${PVE_PM}'"
check "still exactly one hook block after the re-splice" \
  "[ \"\$(grep -cF '${MARKER}' '${PVE_PM}')\" = '1' ]"
run_uninstall; rc=$?
check "uninstall exits 0" "[ ${rc} -eq 0 ]"
check "module is byte-identical to v2 (NOT downgraded to v1)" "cmp -s '${PVE_PM}' '${V2}'"
check "module does NOT equal v1" "! cmp -s '${PVE_PM}' '${V1}'"
check "upgraded module compiles after uninstall" "perl -c '${PVE_PM}' >/dev/null 2>&1"
check "no .anas-orig created or left across the upgrade cycle" "[ ! -f '${PVE_PM}.anas-orig' ]"
rm -rf "${WORK}"

echo "== 15. stale .anas-orig present before install: install removes it =="
setup_env
make_anyevent "${PVE_PM}"
cp "${PVE_PM}" "${PRISTINE}"
printf 'STALE FROM AN OLDER INSTALL\n' > "${PVE_PM}.anas-orig"
PERL_BIN_OVERRIDE="" run_install; rc=$?
check "install exits 0 with a stale backup present" "[ ${rc} -eq 0 ]"
check "install removed the stale backup" "[ ! -f '${PVE_PM}.anas-orig' ]"
check "install log says why" "grep -qi 'stale' '${WORK}/install.log'"
check "hook spliced despite the stale backup" "grep -qF '${MARKER}' '${PVE_PM}'"
check "live module is the splice, not the stale contents" \
  "! grep -qF 'STALE FROM AN OLDER INSTALL' '${PVE_PM}'"
rm -rf "${WORK}"

echo "== 16. stale .anas-orig present before uninstall: removed, never used =="
setup_env
make_anyevent "${PVE_PM}"
cp "${PVE_PM}" "${PRISTINE}"
PERL_BIN_OVERRIDE="" run_install >/dev/null 2>&1
# Contents that would be unmistakable if the uninstall ever adopted them.
printf 'package PVE::APIServer::AnyEvent; # STALE-MUST-NOT-BE-USED\n1;\n' > "${PVE_PM}.anas-orig"
run_uninstall; rc=$?
check "uninstall exits 0 with a stale backup present" "[ ${rc} -eq 0 ]"
check "uninstall removed the stale backup" "[ ! -f '${PVE_PM}.anas-orig' ]"
check "module restored byte-pristine by excision (not by restore)" "cmp -s '${PVE_PM}' '${PRISTINE}'"
check "stale contents never reached the module" \
  "! grep -qF 'STALE-MUST-NOT-BE-USED' '${PVE_PM}'"
rm -rf "${WORK}"

echo
echo "proxy-install tests: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
