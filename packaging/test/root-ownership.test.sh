#!/usr/bin/env bash
#
# Tests for installer.2: the installed tree is root's. The release tarball was
# built with plain `tar czf`, so every entry carried the build host user's
# uid/gid, and install.sh's `cp -a` preserved them onto the node — /opt/anas,
# including code root executes (the daemon, the gateway, the apt hook), owned
# by a regular account. Two-layer fix: the tarball bakes in root ownership
# (--owner=0 --group=0 --numeric-owner), and install.sh chowns the copied tree
# root:root after the copy (which also repairs existing installs on upgrade).
#
# phase1_install is exercised against a fake root: a staged release (the
# preflight-refusal layout) plus a throwaway PREFIX/SYSTEMD_DIR/hooks dir/
# template dir/TPL/JS dir, and a PATH fronted by stubs that record argv —
# systemctl and curl succeed, chown records its argv AND how many entries the
# target directory already had when it was called (proving the chown runs
# AFTER the copy populated PREFIX, not before). No root, no real node.
#
# Covers:
#   1. make-release.sh: the tar line carries --owner=0 --group=0
#      --numeric-owner, and those flags really record 0/0 in the archive
#      (even when the build runs as an unprivileged user).
#   2. install.sh: chown -R root:root "${PREFIX}" sits after the cp -a.
#   3. phase1_install calls chown exactly once, with -R root:root PREFIX,
#      after the copy has populated PREFIX; nothing else in the release-tree
#      copy path preserves build-host ids (every other placement uses
#      `install -m`, which creates fresh root-owned files).
#
#   bash packaging/test/root-ownership.test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "${HERE}/.." && pwd)"
INSTALL="${PKG}/install.sh"
RELEASE="${PKG}/make-release.sh"

PASS=0
FAIL=0
ok()   { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }
check(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

echo "== 1. make-release.sh: tar bakes in root ownership =="
check "tar passes --owner=0 --group=0 --numeric-owner" \
  "grep -qE '^tar czf .*--owner=0 --group=0 --numeric-owner' '${RELEASE}'"
check "the flags sit on the tar line, not in a comment" \
  "grep -qE '^tar czf .*--owner=0 --group=0 --numeric-owner.*-C \"\\\$\{STAGING\}\" \"\\\$\{RELEASE_NAME\}\"' '${RELEASE}'"

# The flags are proven, not just grepped: build a small tree and archive it
# with the exact invocation; every entry must list 0/0 under --numeric-owner,
# even though this test runs as an ordinary user.
GT_STAGE="${WORK}/stage/anas-9.9.9"
mkdir -p "${GT_STAGE}/app" "${GT_STAGE}/systemd"
printf 'x\n' > "${GT_STAGE}/VERSION"
printf 'x\n' > "${GT_STAGE}/app/daemon.js"
tar czf "${WORK}/rel.tar.gz" --owner=0 --group=0 --numeric-owner -C "${WORK}/stage" anas-9.9.9
GT_OWN="$(tar tvzf "${WORK}/rel.tar.gz" --numeric-owner | awk '{print $2}' | sort -u)"
if [ "${GT_OWN}" = "0/0" ]; then
  ok "the archive records uid/gid 0 for every entry"
else
  bad "the archive records uid/gid 0 for every entry (got '${GT_OWN}')"
fi
check "and modes survive the ownership rewrite" \
  "tar tvzf '${WORK}/rel.tar.gz' --numeric-owner | grep -qE '^-rw-r--r--'"

echo "== 2. install.sh: chown root:root after the copy =="
check "chown -R root:root \${PREFIX} present" \
  "grep -qF 'chown -R root:root \"\${PREFIX}\"' '${INSTALL}'"
check "it follows the cp -a of the app tree" \
  "awk '/cp -a \"\\\${APP_SRC}\" \"\\\${PREFIX}\"/{c=NR} /^  chown -R root:root/{exit !(c && NR>c)}' '${INSTALL}'"

echo "== 3. phase1_install issues the chown (fake root) =="
FAKEBIN="${WORK}/bin"
mkdir -p "${FAKEBIN}"
# systemctl: always succeed, record argv. curl: answer 200 immediately.
# udevadm: succeed. chown: record argv plus how populated the target is.
cat > "${FAKEBIN}/systemctl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${WORK}/systemctl.log"
exit 0
EOF
cat > "${FAKEBIN}/curl" <<'EOF'
#!/usr/bin/env bash
printf '200'
exit 0
EOF
cat > "${FAKEBIN}/udevadm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "${FAKEBIN}/chown" <<EOF
#!/usr/bin/env bash
target="\${*: -1}"
n=0
[ -d "\${target}" ] && n=\$(ls -A "\${target}" 2>/dev/null | wc -l)
printf '%s | entries=%s\n' "\$*" "\$n" >> "${WORK}/chown.log"
exit 0
EOF
chmod +x "${FAKEBIN}/systemctl" "${FAKEBIN}/curl" "${FAKEBIN}/udevadm" "${FAKEBIN}/chown"

# Lay out a complete release the way make-release.sh does, plus a
# pve-integration/install.sh stub that performs the two effects phase1
# verifies (anas.js in the JS dir, the script line in the template).
REL="${WORK}/anas-9.9.9"
mkdir -p "${REL}/app/packages/daemon/dist" "${REL}/app/packages/pve-integration" \
         "${REL}/systemd" "${REL}/templates"
cp "${PKG}/install.sh" "${REL}/"
printf '9.9.9\n' > "${REL}/VERSION"
cp "${PKG}/anas-md-event.sh" "${PKG}/anas-cache-event.sh" "${PKG}/anas-cache.rules" "${REL}/"
cp -a "${PKG}/systemd/." "${REL}/systemd/"
cp "${PKG}"/templates/anas-*.txt.hbs "${REL}/templates/"
for t in recycle-purge.js backup-task.js cloud-task.js; do
  : > "${REL}/app/packages/daemon/dist/${t}"
done
cat > "${REL}/app/packages/pve-integration/install.sh" <<'EOF'
#!/usr/bin/env bash
mkdir -p "${PVE_JS_DIR}"
printf '// stub\n' > "${PVE_JS_DIR}/anas.js"
printf '<script src="/pve2/js/anas.js"></script>\n' >> "${PVE_TPL}"
EOF
chmod +x "${REL}/app/packages/pve-integration/install.sh"

PVE_TPL="${WORK}/index.html.tpl"
: > "${PVE_TPL}"

# Directories the real installer inherits from the OS (/etc/systemd/system,
# /usr/local/bin already exist on a node).
mkdir -p "${WORK}/etc-systemd" "${WORK}/bin-anas"
PREFIX="${WORK}/opt-anas"
PHASE1_LOG="${WORK}/phase1.log"
rc=0
PREFIX="${PREFIX}" \
SYSTEMD_DIR="${WORK}/etc-systemd" \
ANAS_ENV_FILE="${WORK}/etc-default-anas" \
HOOK_DEST="${WORK}/bin-anas/anas-md-event" \
CACHE_HOOK_DEST="${WORK}/bin-anas/anas-cache-event" \
UDEV_RULES_DIR="${WORK}/udev-rules" \
CACHE_RULE_DEST="${WORK}/udev-rules/99-anas-cache.rules" \
PVE_TEMPLATE_DIR="${WORK}/pve-templates" \
PVE_TPL="${PVE_TPL}" \
PVE_JS_DIR="${WORK}/pve-js" \
ANAS_INSTALL_LIB_ONLY=1 \
PATH="${FAKEBIN}:${PATH}" \
  bash -c 'source "$0"; RESOLVED_PORT=3000; HEALTH_PORT=3000; phase1_install' \
  "${REL}/install.sh" >"${PHASE1_LOG}" 2>&1 || rc=$?

check "phase1_install completes successfully" "[ ${rc} -eq 0 ]"
check "chown was called exactly once" "[ \"\$(wc -l < '${WORK}/chown.log' 2>/dev/null || echo 0)\" = '1' ]"
check "chown argv: -R root:root \${PREFIX}" \
  "grep -qF -- '-R root:root ${PREFIX}' '${WORK}/chown.log'"
check "the chown ran after the copy (PREFIX populated)" \
  "! grep -qF -- '-R root:root ${PREFIX} | entries=0' '${WORK}/chown.log'"
check "the copied tree really landed in PREFIX" "[ -f '${PREFIX}/packages/daemon/dist/recycle-purge.js' ]"
# Two-space indent: the chown is a statement of phase1_install itself, not
# nested in an `if` — every run (fresh or upgrade) repairs ownership.
check "the chown is unconditional (statement level in phase1_install)" \
  "grep -qE '^  chown -R root:root \"\\\$\\{PREFIX\\}\"$' '${INSTALL}'"

echo
echo "root-ownership tests: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
