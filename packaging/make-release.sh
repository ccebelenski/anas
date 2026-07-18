#!/usr/bin/env bash
#
# Build an ANAS production release tarball ON the dev host.
#
# Produces dist-release/anas-<version>.tar.gz which untars to a release root
# (anas-<version>/) containing install.sh, uninstall.sh, the systemd units, and
# an app/ tree (destined for /opt/anas) with dist output, package manifests, the
# pve-integration sources, and a PRODUCTION-ONLY node_modules.
#
# The pruned node_modules is built with `npm ci --omit=dev --ignore-scripts` in a
# throwaway tree that mirrors the workspace layout, so it contains only runtime
# deps (fastify, zod, @anas/* workspace symlinks) — never playwright/tsc/tsx/etc.
# The staged tree is then smoke-tested: the daemon and gateway must BOOT using
# ONLY the pruned node_modules (no MODULE_NOT_FOUND) before we tar it.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Runtime workspaces that ship in the release (must match the lockfile's
# workspace set so `npm ci` is happy against package-lock.json).
WORKSPACES=(shared daemon gateway)

# --dev: iteration build — skip the clean-tree gate and the git tag. A release
# built without --dev must come from a committed tree and gets tagged v<version>.
DEV_BUILD=0
case "${1:-}" in
  --dev) DEV_BUILD=1 ;;
  "") ;;
  *) printf 'usage: %s [--dev]\n' "$0" >&2; exit 2 ;;
esac

log() { printf '==> %s\n' "$*"; }
err() { printf 'ERROR: %s\n' "$*" >&2; }

# --- 0. Version (single source: root package.json) ---------------------------
# Verify every copy agrees BEFORE building — the bump script (bump-version.mjs)
# writes them all, but drift must fail loudly, not ship (story 10.10).
VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"
if [ -z "${VERSION}" ] || [ "${VERSION}" = "undefined" ]; then
  err "could not read version from package.json"
  exit 1
fi
for p in "${WORKSPACES[@]}"; do
  wv="$(node -p "require('${REPO_ROOT}/packages/${p}/package.json').version")"
  if [ "${wv}" != "${VERSION}" ]; then
    err "version drift: packages/${p} is ${wv}, root is ${VERSION} — run: npm run version:bump -- ${VERSION}"
    exit 1
  fi
done
SRC_VERSION="$(sed -n "s/^export const VERSION = '\(.*\)'$/\1/p" "${REPO_ROOT}/packages/shared/src/index.ts")"
if [ "${SRC_VERSION}" != "${VERSION}" ]; then
  err "version drift: shared VERSION const is '${SRC_VERSION}', root is ${VERSION} — run: npm run version:bump -- ${VERSION}"
  exit 1
fi
RELEASE_NAME="anas-${VERSION}"
log "Release version: ${VERSION}"

# Clean-tree gate: a real release must be reproducible from a commit.
if [ "${DEV_BUILD}" -eq 0 ] && [ -n "$(git -C "${REPO_ROOT}" status --porcelain)" ]; then
  err "working tree is dirty — commit first, or use --dev for an untagged iteration build"
  exit 1
fi

# --- 1. Build (shared -> daemon -> gateway) --------------------------------
log "Building ANAS (npm run build)..."
cd "${REPO_ROOT}"
npm run build
log "Build complete."

# --- 3. Staging tree --------------------------------------------------------
STAGING="$(mktemp -d)"
PRUNE_TMP="$(mktemp -d)"
cleanup() { rm -rf "${STAGING}" "${PRUNE_TMP}"; }
trap cleanup EXIT

REL_ROOT="${STAGING}/${RELEASE_NAME}"
APP="${REL_ROOT}/app"
mkdir -p "${APP}"

log "Assembling staging tree at ${REL_ROOT}"

# Release-root files.
install -m 0755 "${SCRIPT_DIR}/install.sh"   "${REL_ROOT}/install.sh"
install -m 0755 "${SCRIPT_DIR}/uninstall.sh" "${REL_ROOT}/uninstall.sh"
printf '%s\n' "${VERSION}" > "${REL_ROOT}/VERSION"
# Also inside app/ — cp -a carries it to /opt/anas, so an installed node can
# report its release on disk (install.sh reads it for upgrade/downgrade logs).
printf '%s\n' "${VERSION}" > "${APP}/VERSION"
mkdir -p "${REL_ROOT}/systemd"
cp "${SCRIPT_DIR}/systemd/anasd.service" "${REL_ROOT}/systemd/anasd.service"
cp "${SCRIPT_DIR}/systemd/anas.service"  "${REL_ROOT}/systemd/anas.service"

# app/ root manifest (the workspace root package.json — carries the "type":
# "module" and workspaces glob the daemon/gateway rely on for resolution).
cp "${REPO_ROOT}/package.json" "${APP}/package.json"

# app/packages/<name>/{dist,package.json} for each runtime workspace.
for p in "${WORKSPACES[@]}"; do
  src="${REPO_ROOT}/packages/${p}"
  dst="${APP}/packages/${p}"
  if [ ! -d "${src}/dist" ]; then
    err "missing build output ${src}/dist — did the build run?"
    exit 1
  fi
  mkdir -p "${dst}"
  cp -a "${src}/dist" "${dst}/dist"
  cp "${src}/package.json" "${dst}/package.json"
done

# app/packages/pve-integration/{src,install.sh,uninstall.sh} (no build step).
PVE_SRC="${REPO_ROOT}/packages/pve-integration"
PVE_DST="${APP}/packages/pve-integration"
mkdir -p "${PVE_DST}"
cp -a "${PVE_SRC}/src" "${PVE_DST}/src"
install -m 0755 "${PVE_SRC}/install.sh"   "${PVE_DST}/install.sh"
install -m 0755 "${PVE_SRC}/uninstall.sh" "${PVE_DST}/uninstall.sh"
# Ship the README too if present (operator docs for the fragile tpl step).
[ -f "${PVE_SRC}/README.md" ] && cp "${PVE_SRC}/README.md" "${PVE_DST}/README.md"

# --- 4. Production-only node_modules ---------------------------------------
# Mirror the workspace layout in a throwaway dir, then `npm ci --omit=dev`.
log "Building production node_modules (npm ci --omit=dev --ignore-scripts)..."
cp "${REPO_ROOT}/package.json"      "${PRUNE_TMP}/package.json"
cp "${REPO_ROOT}/package-lock.json" "${PRUNE_TMP}/package-lock.json"
for p in "${WORKSPACES[@]}"; do
  mkdir -p "${PRUNE_TMP}/packages/${p}"
  cp "${REPO_ROOT}/packages/${p}/package.json" "${PRUNE_TMP}/packages/${p}/package.json"
done
(
  cd "${PRUNE_TMP}"
  npm ci --omit=dev --ignore-scripts
)
if [ ! -d "${PRUNE_TMP}/node_modules" ]; then
  err "npm ci did not produce node_modules"
  exit 1
fi
# Copy the pruned tree into app/. The @anas/* entries are RELATIVE symlinks
# (../../packages/<name>); preserving them with cp -a keeps them valid because
# app/ reproduces the same node_modules <-> packages relative layout.
cp -a "${PRUNE_TMP}/node_modules" "${APP}/node_modules"
NM_SIZE="$(du -sh "${APP}/node_modules" | awk '{print $1}')"
log "Pruned node_modules: ${NM_SIZE}"

# --- 5. Smoke test: daemon + gateway must BOOT on the pruned node_modules ---
log "Smoke-testing daemon and gateway boot (pruned node_modules only)..."
SMOKE_SOCK="$(mktemp -u /tmp/anas-smoke.XXXXXX.sock)"
SMOKE_PORT=31743
smoke_fail=0

# Daemon: boots and creates its unix socket.
DAEMON_LOG="$(mktemp)"
ANASD_SOCKET="${SMOKE_SOCK}" node "${APP}/packages/daemon/dist/index.js" >"${DAEMON_LOG}" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 30); do
  [ -S "${SMOKE_SOCK}" ] && break
  kill -0 "${DAEMON_PID}" 2>/dev/null || break
  sleep 0.2
done
if grep -qiE "MODULE_NOT_FOUND|Cannot find (module|package)" "${DAEMON_LOG}"; then
  err "daemon smoke test: module resolution failure"
  cat "${DAEMON_LOG}" >&2
  smoke_fail=1
elif kill -0 "${DAEMON_PID}" 2>/dev/null && [ -S "${SMOKE_SOCK}" ]; then
  log "  daemon booted (socket ${SMOKE_SOCK} created)"
else
  err "daemon smoke test: process did not stay up / no socket"
  cat "${DAEMON_LOG}" >&2
  smoke_fail=1
fi

# Gateway: boots and listens. Use the dev auth provider and no PVE certs so it
# serves plain HTTP on a throwaway port — we only assert it does not crash on a
# missing module. It talks to the daemon socket above.
GATEWAY_LOG="$(mktemp)"
ANASD_SOCKET="${SMOKE_SOCK}" ANAS_AUTH_PROVIDER=dev ANAS_PORT="${SMOKE_PORT}" \
  node "${APP}/packages/gateway/dist/index.js" >"${GATEWAY_LOG}" 2>&1 &
GATEWAY_PID=$!
for _ in $(seq 1 30); do
  grep -qiE "listening|MODULE_NOT_FOUND|Cannot find" "${GATEWAY_LOG}" && break
  kill -0 "${GATEWAY_PID}" 2>/dev/null || break
  sleep 0.2
done
if grep -qiE "MODULE_NOT_FOUND|Cannot find (module|package)" "${GATEWAY_LOG}"; then
  err "gateway smoke test: module resolution failure"
  cat "${GATEWAY_LOG}" >&2
  smoke_fail=1
elif kill -0 "${GATEWAY_PID}" 2>/dev/null && grep -qi "listening" "${GATEWAY_LOG}"; then
  log "  gateway booted (listening on port ${SMOKE_PORT})"
else
  err "gateway smoke test: process did not stay up / not listening"
  cat "${GATEWAY_LOG}" >&2
  smoke_fail=1
fi

# Tear down smoke processes.
kill "${GATEWAY_PID}" "${DAEMON_PID}" 2>/dev/null || true
wait "${GATEWAY_PID}" 2>/dev/null || true
wait "${DAEMON_PID}" 2>/dev/null || true
rm -f "${SMOKE_SOCK}" "${DAEMON_LOG}" "${GATEWAY_LOG}"

if [ "${smoke_fail}" -ne 0 ]; then
  err "smoke test FAILED — refusing to build a broken release. Check node_modules pruning."
  exit 1
fi
log "Smoke test passed."

# --- 6. Tar -----------------------------------------------------------------
OUT_DIR="${REPO_ROOT}/dist-release"
mkdir -p "${OUT_DIR}"
TARBALL="${OUT_DIR}/${RELEASE_NAME}.tar.gz"
rm -f "${TARBALL}"
tar czf "${TARBALL}" -C "${STAGING}" "${RELEASE_NAME}"

TAR_SIZE="$(du -h "${TARBALL}" | awk '{print $1}')"
log "Release tarball: ${TARBALL} (${TAR_SIZE})"

# --- 7. Tag -----------------------------------------------------------------
# Only for real (non --dev) builds, which passed the clean-tree gate. Idempotent:
# tag already at HEAD is fine; tag elsewhere means the version wasn't bumped.
if [ "${DEV_BUILD}" -eq 0 ]; then
  TAG="v${VERSION}"
  if git -C "${REPO_ROOT}" rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
    if [ "$(git -C "${REPO_ROOT}" rev-parse "${TAG}^{commit}")" = "$(git -C "${REPO_ROOT}" rev-parse HEAD)" ]; then
      log "Tag ${TAG} already at HEAD."
    else
      err "tag ${TAG} exists on a different commit — bump the version (npm run version:bump) before releasing"
      exit 1
    fi
  else
    git -C "${REPO_ROOT}" tag -a "${TAG}" -m "ANAS ${VERSION}"
    log "Tagged ${TAG} (push with: git push origin ${TAG})"
  fi
else
  log "Dev build — skipping tag."
fi

printf '\nDone. Untar on the target PVE node and run: sudo ./%s/install.sh\n' "${RELEASE_NAME}"
