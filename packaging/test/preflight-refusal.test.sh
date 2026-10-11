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

WORK="$(mktemp -d)"
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
  for t in recycle-purge.js backup-task.js cloud-task.js; do
    : > "${rel}/app/packages/daemon/dist/${t}"
  done
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
            templates/anas-ahr-subject.txt.hbs templates/anas-cloud-body.txt.hbs \
            templates/anas-integration-subject.txt.hbs; do
  stage_release "${REL}"
  rm -f "${REL}/${need}"
  preflight "${REL}"; rc=$?
  check "missing ${need} -> refused and named" \
    "[ ${rc} -ne 0 ] && [ \"\$(missing_line)\" = '${need}' ]"
done

echo
echo "preflight-refusal tests: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
