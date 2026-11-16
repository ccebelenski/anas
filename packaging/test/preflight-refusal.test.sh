#!/usr/bin/env bash
#
# Tests for packaging/install.sh's "release incomplete" refusal (story
# installer.1, GitHub #74). The reporter ran install.sh from a directory missing
# VERSION and the three hook files; the refusal listed the files but named
# neither the directory it had checked nor the fix.
#
# A fake release is staged in a throwaway directory (install.sh copied in, the
# siblings make-release.sh ships laid out beside it) and install.sh is sourced in
# ANAS_INSTALL_LIB_ONLY mode so ONLY phase0_preflight runs — read-only by design,
# with PREFIX/ANAS_ENV_FILE pointed into the scratch dir and ss/systemctl faked.
# Nothing here can install anything, even when run as root on a real PVE node.
#
# Covers:
#   1. a complete release raises no "release incomplete" entry (control).
#   2. VERSION removed -> refusal names the directory, VERSION, the layout and
#      the fix; the node is reported unmodified and nothing was written.
#   3. the reporter's shape (VERSION + the three hook files) -> all four named.
#   4. app/ removed -> app/ named once, not every file under it.
#   5. a missing template with VERSION present -> named, and the fix carries
#      the release's own version.
#   6. every pre-installer.1 requirement still refuses (behaviour, not text).
#   7. ss missing (cr4): a check that could not run does not pass — preflight
#      refuses, naming ss, package iproute2, and the install command.
#   8. --prefix (cr4 fold 5) is parsed by the allow-list the help states:
#      starting with '/' and carrying only letters, digits and the path
#      characters / . - _; anything else is refused at argument parsing,
#      naming the characters that work.
#   9. ss PRESENT but exiting non-zero (cr4 fold, probe C): port_listening
#      answers one of three (listening / free / could not check) and preflight
#      refuses on the third, naming the command that failed and its exit status.
#
#   bash packaging/test/preflight-refusal.test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "${HERE}/.." && pwd)"

PASS=0
FAIL=0
ok()   { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

WORK="$(mktemp -d -p "${ANAS_TEST_TMPDIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}" .scratch.XXXXXX)"
trap 'rm -rf "${WORK}"' EXIT

# Fakes: ss reports nothing listening; systemctl says nothing is active.
cat > "${WORK}/ss" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "${WORK}/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 3
EOF
chmod +x "${WORK}/ss" "${WORK}/systemctl"

# Lay out a COMPLETE release at $1, shaped as make-release.sh builds it.
stage_release() {
  local rel="$1" t
  rm -rf "${rel}"
  mkdir -p "${rel}/app/packages/daemon/dist" "${rel}/systemd" "${rel}/templates"
  cp "${PKG}/install.sh" "${PKG}/uninstall.sh" "${rel}/"
  printf '9.9.9\n' > "${rel}/VERSION"
  cp "${PKG}/anas-md-event.sh" "${PKG}/anas-cache-event.sh" "${PKG}/anas-cache.rules" "${rel}/"
  cp -a "${PKG}/systemd/." "${rel}/systemd/"
  cp "${PKG}"/templates/anas-*.txt.hbs "${rel}/templates/"
  for t in recycle-purge.js backup-task.js cloud-task.js replicate-task.js repl-drift-check.js; do
    : > "${rel}/app/packages/daemon/dist/${t}"
  done
  mkdir -p "${rel}/app/packages/daemon/dist/services"
  : > "${rel}/app/packages/daemon/dist/services/anas-acl-walk.pl"
}

# Run ONLY the read-only preflight from the staged release; output -> $LOG.
preflight() {
  local rel="$1"
  LOG="${WORK}/preflight.log"
  ANAS_INSTALL_LIB_ONLY=1 \
  PREFIX="${WORK}/opt-anas" \
  ANAS_ENV_FILE="${WORK}/etc-default-anas" \
  SS_BIN="${WORK}/ss" SYSTEMCTL_BIN="${WORK}/systemctl" \
    bash -c 'source "$0"; phase0_preflight' "${rel}/install.sh" >"${LOG}" 2>&1
}

# The single "missing:" line of the refusal, without its label.
missing_line() { sed -n 's/^ *missing:  //p' "${LOG}"; }

REL="${WORK}/anas-9.9.9"

# =============================================================================
echo "== 1. complete release: no release-incomplete entry =="
stage_release "${REL}"
preflight "${REL}"
check "no 'release incomplete' in the output" "! grep -q 'release incomplete' '${LOG}'"
check "no 'missing:' line" "! grep -q 'missing:' '${LOG}'"

echo "== 2. VERSION removed: directory, file, layout and fix are named =="
stage_release "${REL}"
rm -f "${REL}/VERSION"
preflight "${REL}"; rc=$?
check "preflight refuses (non-zero exit)" "[ ${rc} -ne 0 ]"
check "says the node was NOT modified" "grep -qF 'preflight failed — the node was NOT modified' '${LOG}'"
check "says the release is incomplete" "grep -q 'release incomplete' '${LOG}'"
check "names the directory it checked" "grep -qF 'checked:  ${REL}' '${LOG}'"
check "names VERSION as missing" "[ \"\$(missing_line)\" = 'VERSION' ]"
check "prints the expected layout in one line" \
  "grep -qF 'expected: install.sh uninstall.sh VERSION anas-md-event.sh anas-cache-event.sh anas-cache.rules app/ systemd/ templates/' '${LOG}'"
check "prints the fix: re-extract into a fresh directory" \
  "grep -qF 're-extract the release asset into a fresh, empty directory and run ./install.sh from inside it' '${LOG}'"
check "the fix's commands end in ./install.sh run from inside the extraction" \
  "grep -qF 'cd anas-fresh/anas-<version> && sudo ./install.sh' '${LOG}'"
check "version unknown -> the fix uses a <version> placeholder" \
  "grep -qF 'tar xzf anas-<version>.tar.gz -C anas-fresh' '${LOG}'"
check "nothing written: no PREFIX" "[ ! -e '${WORK}/opt-anas' ]"
check "nothing written: no env file" "[ ! -e '${WORK}/etc-default-anas' ]"

echo "== 3. GitHub #74 shape: VERSION and the three hook files missing =="
stage_release "${REL}"
rm -f "${REL}/VERSION" "${REL}/anas-md-event.sh" "${REL}/anas-cache-event.sh" "${REL}/anas-cache.rules"
preflight "${REL}"; rc=$?
check "preflight refuses" "[ ${rc} -ne 0 ]"
check "all four named, in layout order" \
  "[ \"\$(missing_line)\" = 'VERSION, anas-md-event.sh, anas-cache-event.sh, anas-cache.rules' ]"
check "directory named" "grep -qF 'checked:  ${REL}' '${LOG}'"
check "exactly one release-incomplete entry" "[ \"\$(grep -c 'release incomplete' '${LOG}')\" = '1' ]"

echo "== 4. app/ missing: named once, not file by file =="
stage_release "${REL}"
rm -rf "${REL}/app"
preflight "${REL}"; rc=$?
check "preflight refuses" "[ ${rc} -ne 0 ]"
check "app/ is the one missing entry" "[ \"\$(missing_line)\" = 'app/' ]"
check "no file under app/ listed" "! grep -q 'app/packages' '${LOG}'"

echo "== 5. one template missing, VERSION present: fix carries the version =="
stage_release "${REL}"
rm -f "${REL}/templates/anas-integration-body.txt.hbs"
preflight "${REL}"; rc=$?
check "preflight refuses" "[ ${rc} -ne 0 ]"
check "the template is named with its directory" \
  "[ \"\$(missing_line)\" = 'templates/anas-integration-body.txt.hbs' ]"
check "the fix names this release's asset" "grep -qF 'tar xzf anas-9.9.9.tar.gz -C anas-fresh' '${LOG}'"
check "and its extraction directory" "grep -qF 'cd anas-fresh/anas-9.9.9 && sudo ./install.sh' '${LOG}'"

echo "== 6. every pre-installer.1 requirement still refuses (behaviour, not text) =="
# Each path the old one-line-per-file checks required, removed on its own: the
# refusal must still fire and name it. Pins that the move onto release_need
# kept every existing check.
for need in VERSION systemd/anasd.service systemd/anas.service anas-md-event.sh \
            anas-cache-event.sh anas-cache.rules \
            systemd/rtslib-fb-targetctl.service.d/anas-ordering.conf \
            systemd/anas-recycle.timer systemd/anas-recycle.service \
            app/packages/daemon/dist/recycle-purge.js \
            app/packages/daemon/dist/backup-task.js \
            app/packages/daemon/dist/cloud-task.js \
            app/packages/daemon/dist/replicate-task.js \
            app/packages/daemon/dist/repl-drift-check.js \
            app/packages/daemon/dist/services/anas-acl-walk.pl \
            templates/anas-ahr-subject.txt.hbs templates/anas-cloud-body.txt.hbs \
            templates/anas-integration-subject.txt.hbs; do
  stage_release "${REL}"
  rm -f "${REL}/${need}"
  preflight "${REL}"; rc=$?
  check "missing ${need} -> refused and named" \
    "[ ${rc} -ne 0 ] && [ \"\$(missing_line)\" = '${need}' ]"
done

# =============================================================================
# cr4 (N): port_listening answers "port free" when ss is missing. The port
# check that could not run must never pass, so preflight refuses the install
# naming the tool and its package — before the first change. SS_BIN is pointed
# at a path that does not exist; the fake systemctl keeps the run read-only.
echo "== 7. ss missing: preflight refuses naming ss and iproute2 =="
stage_release "${REL}"
LOG="${WORK}/preflight.log"
ANAS_INSTALL_LIB_ONLY=1 \
PREFIX="${WORK}/opt-anas" \
ANAS_ENV_FILE="${WORK}/etc-default-anas" \
SS_BIN="${WORK}/no-such-ss" SYSTEMCTL_BIN="${WORK}/systemctl" \
  bash -c 'source "$0"; phase0_preflight' "${REL}/install.sh" >"${LOG}" 2>&1
rc=$?
check "preflight refuses (non-zero exit)" "[ ${rc} -ne 0 ]"
check "says the node was NOT modified" "grep -qF 'preflight failed — the node was NOT modified' '${LOG}'"
check "names the missing tool and its package" "grep -qF 'ss not found (package iproute2)' '${LOG}'"
check "the fix names the command to run" "grep -qF 'apt-get install -y iproute2' '${LOG}'"
check "nothing written: no PREFIX" "[ ! -e '${WORK}/opt-anas' ]"
check "nothing written: no env file" "[ ! -e '${WORK}/etc-default-anas' ]"
# Control: with ss present on PATH (the stub at ${WORK}/ss), no iproute2 entry.
preflight "${REL}"
check "with ss present, no iproute2 entry appears" "! grep -qF 'iproute2' '${LOG}'"

# =============================================================================
# cr4 fold 5: install_units rewrites every unit with
# `sed "s#/opt/anas#${PREFIX}#g"`. The review measured, and this fold
# re-measured: '&' and '\' substitute silently and corrupt every unit file,
# while '#' and a newline make sed exit non-zero so no substitution happens
# at all. Either way the installer cannot substitute such a prefix into its
# unit files, and the error says exactly that, nothing more. The parser is
# now the allow-list the usage text always read as: a prefix starting with
# '/' and carrying only letters, digits and the path characters / . - _.
# The old deny-list of four characters let a prefix with a space, '+' or
# '%' through, and let a relative path through. Argument parsing refuses
# anything outside the set (exit 2, the usage-error status), before the
# first change.
echo "== 8. --prefix outside the path characters: refused at parse time =="
stage_release "${REL}"
BAD_NAMES=('&' '#' 'a backslash' 'a newline' 'a space' '+' '%' 'no leading slash' 'empty')
BAD_PREFIXES=("${WORK}/a&nas" "${WORK}/a#nas" "${WORK}/a\\nas" "${WORK}/a"$'\n'"nas" \
              "${WORK}/a nas" "${WORK}/a+nas" "${WORK}/a%nas" "relpath-anas" "")
for i in "${!BAD_NAMES[@]}"; do
  bad="${BAD_PREFIXES[$i]}"
  LOG="${WORK}/preflight.log"
  ANAS_INSTALL_LIB_ONLY=1 \
  ANAS_ENV_FILE="${WORK}/etc-default-anas" \
  SS_BIN="${WORK}/ss" SYSTEMCTL_BIN="${WORK}/systemctl" \
    bash -c 'source "$0"; phase0_preflight' "${REL}/install.sh" --prefix "${bad}" >"${LOG}" 2>&1
  rc=$?
  check "--prefix with ${BAD_NAMES[$i]} is refused with exit 2 (usage error)" "[ ${rc} -eq 2 ]"
  check "  the error names the option and says the installer cannot substitute it" \
    "grep -qF -- \"--prefix '\" '${LOG}' && grep -qF \"cannot be substituted into the installer's unit files\" '${LOG}'"
  check "  the error names the characters that work" \
    "grep -qF 'letters, digits and the path characters' '${LOG}'"
  check "  the error gives a working example" \
    "grep -qF 'for example /opt/anas or /srv/anas-1' '${LOG}'"
  check "  nothing written: no prefix path, no env file" \
    "[ ! -e \"${bad}\" ] && [ ! -e '${WORK}/etc-default-anas' ]"
done
# Controls: a plain prefix, and one carrying '.', '-' and '_', pass argument
# parsing (the preflight then runs and fails only on this machine's own
# missing PVE, exactly as in scenarios 1-7).
preflight "${REL}"
check "a plain prefix raises no --prefix refusal" \
  "! grep -qF \"cannot be substituted into the installer's unit files\" '${LOG}'"
LOG="${WORK}/preflight.log"
ANAS_INSTALL_LIB_ONLY=1 \
ANAS_ENV_FILE="${WORK}/etc-default-anas" \
SS_BIN="${WORK}/ss" SYSTEMCTL_BIN="${WORK}/systemctl" \
  bash -c 'source "$0"; phase0_preflight' "${REL}/install.sh" --prefix "${WORK}/opt_anas.v1-x" >"${LOG}" 2>&1
check "a prefix carrying '.', '-' and '_' passes argument parsing" \
  "! grep -qF \"cannot be substituted into the installer's unit files\" '${LOG}'"

# =============================================================================
# cr4 fold (probe C): an ss that is PRESENT but exits non-zero. The old code
# ran it behind `|| true`, so a listing that never completed answered "port
# free" for every port: the --port collision guard and the fresh-install
# auto-scan both open on that answer. The same rule as scenario 7: a check
# that could not run never passes. port_listening answers three ways
# (listening / free / could not check) and preflight refuses on the third,
# naming the command that failed and its exit status.
echo "== 9. ss present but failing: preflight refuses, naming command and status =="
stage_release "${REL}"
# The probe C input: this ss PRINTS :3000 as LISTENing and then fails. The
# output must not matter — the listing did not complete.
cat > "${WORK}/ss-failing" <<'EOF'
#!/usr/bin/env bash
printf 'State  Recv-Q  Send-Q     Local Address:Port  Peer Address:Port\n'
printf 'LISTEN 0       128       127.0.0.1:3000        0.0.0.0:*\n'
exit 1
EOF
# Control ss: the same listing, exiting 0.
cat > "${WORK}/ss-listening" <<'EOF'
#!/usr/bin/env bash
printf 'State  Recv-Q  Send-Q     Local Address:Port  Peer Address:Port\n'
printf 'LISTEN 0       128       127.0.0.1:3000        0.0.0.0:*\n'
exit 0
EOF
chmod +x "${WORK}/ss-failing" "${WORK}/ss-listening"
LOG="${WORK}/preflight.log"
ANAS_INSTALL_LIB_ONLY=1 \
PREFIX="${WORK}/opt-anas" \
ANAS_ENV_FILE="${WORK}/etc-default-anas" \
SS_BIN="${WORK}/ss-failing" SYSTEMCTL_BIN="${WORK}/systemctl" \
  bash -c 'source "$0"; phase0_preflight' "${REL}/install.sh" >"${LOG}" 2>&1
rc=$?
check "preflight refuses (non-zero exit)" "[ ${rc} -ne 0 ]"
check "says the node was NOT modified" "grep -qF 'preflight failed — the node was NOT modified' '${LOG}'"
check "names the command that failed and its exit status" \
  "grep -qF '${WORK}/ss-failing -ltn exited 1' '${LOG}'"
check "the fix names the command to run for the error" \
  "grep -qF \"Run '${WORK}/ss-failing -ltn'\" '${LOG}'"
check "nothing written: no PREFIX" "[ ! -e '${WORK}/opt-anas' ]"
check "nothing written: no env file" "[ ! -e '${WORK}/etc-default-anas' ]"
# The three answers themselves, called directly (probe C's shape). The port in
# the failing ss's own output must answer could-not-check, never free.
pl_answer() {
  ANAS_INSTALL_LIB_ONLY=1 SS_BIN="$1" ANAS_PROBE_PORT="$2" \
  SYSTEMCTL_BIN="${WORK}/systemctl" \
    bash -c 'source "$0"; rc=0; port_listening "${ANAS_PROBE_PORT}" || rc=$?
      case "${rc}" in
        0) printf LISTENING ;;
        1) printf FREE ;;
        2) printf COULD-NOT-CHECK ;;
        *) printf "OTHER-%s" "${rc}" ;;
      esac' "${REL}/install.sh"
}
got="$(pl_answer "${WORK}/ss-failing" 3000)"
check "failing ss: port_listening answers could-not-check (probe C answered free)" \
  "[ \"${got}\" = 'COULD-NOT-CHECK' ]"
got="$(pl_answer "${WORK}/ss-listening" 3000)"
check "working ss, listening port: still answers listening" "[ \"${got}\" = 'LISTENING' ]"
got="$(pl_answer "${WORK}/ss-listening" 3001)"
check "working ss, idle port: still answers free" "[ \"${got}\" = 'FREE' ]"
# The missing-ss answer moves to the same third state (it never ran either);
# scenario 7 pins the preflight sentence that keeps naming package iproute2.
got="$(pl_answer "${WORK}/no-such-ss" 3000)"
check "missing ss: the same could-not-check answer" "[ \"${got}\" = 'COULD-NOT-CHECK' ]"
# Control: the healthy fake ss of scenarios 1-8 leaves preflight silent on ss.
preflight "${REL}"
check "working ss: no refusal naming a failed ss check" "! grep -qF 'could not read the LISTEN table' '${LOG}'"

# =============================================================================
echo "== 10. PREFIX that exists and is not an ANAS install is refused; an install, an empty directory and a new path are not =="
PFX="${WORK}/opt-anas"
REFUSAL='exists and is not an ANAS install'
rm -rf "${PFX}"; mkdir -p "${PFX}/cron.d"; : > "${PFX}/passwd"
rc=0; preflight "${REL}" || rc=$?
check "a directory holding other files: preflight refuses" "[ ${rc} -ne 0 ]"
check "it names the prefix and why" "grep -qF '${PFX} ${REFUSAL}' '${LOG}'"
check "it says what to choose" "grep -qF 'Choose a path that does not exist yet or an empty directory with --prefix' '${LOG}'"
check "the directory is untouched" "[ -f '${PFX}/passwd' ] && [ -d '${PFX}/cron.d' ]"
rm -rf "${PFX}"; : > "${PFX}"
preflight "${REL}" || true
check "a FILE at the prefix is refused the same way" "grep -qF '${REFUSAL}' '${LOG}'"
rm -f "${PFX}"; mkdir -p "${WORK}/elsewhere"; : > "${WORK}/elsewhere/data"; ln -s "${WORK}/elsewhere" "${PFX}"
preflight "${REL}" || true
check "a LINK to a directory holding other files is refused the same way" "grep -qF '${REFUSAL}' '${LOG}'"
rm -f "${WORK}/elsewhere/data"; printf '9.9.8\n' > "${WORK}/elsewhere/VERSION"
preflight "${REL}" || true
check "a LINK to an ANAS install raises no such refusal" "! grep -qF '${REFUSAL}' '${LOG}'"
rm -f "${PFX}"; ln -s "${WORK}/no-such-dir" "${PFX}"
preflight "${REL}" || true
check "a dangling LINK is refused" "grep -qF '${REFUSAL}' '${LOG}'"
rm -f "${PFX}"; mkdir -p "${PFX}"; printf '9.9.8\n' > "${PFX}/VERSION"
preflight "${REL}" || true
check "an ANAS install (VERSION) raises no such refusal" "! grep -qF '${REFUSAL}' '${LOG}'"
rm -rf "${PFX}"; mkdir -p "${PFX}/packages/daemon"
preflight "${REL}" || true
check "an older ANAS install (packages/daemon, no VERSION) raises none" "! grep -qF '${REFUSAL}' '${LOG}'"
rm -rf "${PFX}"; mkdir -p "${PFX}"
preflight "${REL}" || true
check "an empty directory raises none" "! grep -qF '${REFUSAL}' '${LOG}'"
rm -rf "${PFX}"
preflight "${REL}" || true
check "a path that does not exist yet raises none" "! grep -qF '${REFUSAL}' '${LOG}'"

echo
echo "preflight-refusal tests: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
