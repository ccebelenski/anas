#!/usr/bin/env bash
#
# ANAS production installer. Runs ON a Proxmox VE node, as root, from the
# untarred release root (the directory containing this script, app/ and
# systemd/).
#
# Design: a read-only PHASE 0 preflight that mutates nothing and aborts early
# with a clear summary, followed by a transactional PHASE 1 that records every
# completed step so an ERR trap can reverse them and leave the node unchanged.
#
# ANAS is a guest on the system (PRINCIPLES.md #12): surgical, reversible,
# idempotent. A re-run is a clean in-place upgrade (backup -> install -> drop
# backup on success), never a duplicate unit or a double <script> line.
#
set -euo pipefail

# --- Paths / config ---------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_SRC="${SCRIPT_DIR}/app"
UNIT_SRC="${SCRIPT_DIR}/systemd"

# Overridable (defaults are production). SYSTEMD_DIR is exposed mainly for tests;
# PVE_TPL/PVE_JS_DIR/APT_HOOK are passed through to the pve-integration scripts.
PREFIX="${PREFIX:-/opt/anas}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
NODE_BIN="${NODE_BIN:-node}"
HEALTH_PORT="${HEALTH_PORT:-3000}"

# Flags.
INSTALL_DEPS=0
ASSUME_YES=0
FORCE=0

MIN_NODE_MAJOR=20
MIN_ZFS="2.2"

log()  { printf '==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
err()  { printf 'ERROR: %s\n' "$*" >&2; }

usage() {
  cat <<EOF
ANAS installer

Usage: sudo ./install.sh [options]

Options:
  --install-deps   Auto-install missing dependencies: acl, and Node.js (>= ${MIN_NODE_MAJOR})
                   via the NodeSource setup_22.x repository if absent/too old.
  --yes            Non-interactive; assume "yes" to prompts.
  --prefix DIR     Install location (default: /opt/anas).
  --force          Skip the ZFS >= ${MIN_ZFS} version gate (ANAS needs 'zpool -j').
  -h, --help       Show this help.
EOF
}

# --- Arg parsing ------------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-deps) INSTALL_DEPS=1 ;;
    --yes|-y)       ASSUME_YES=1 ;;
    --force)        FORCE=1 ;;
    --prefix)       shift; [ "$#" -gt 0 ] || { err "--prefix needs an argument"; exit 2; }; PREFIX="$1" ;;
    --prefix=*)     PREFIX="${1#*=}" ;;
    -h|--help)      usage; exit 0 ;;
    *) err "unknown option: $1"; usage >&2; exit 2 ;;
  esac
  shift
done

confirm() {
  # confirm "question" -> 0 if yes. Auto-yes with --yes / non-tty.
  [ "${ASSUME_YES}" -eq 1 ] && return 0
  if [ ! -t 0 ]; then return 0; fi
  local reply
  printf '%s [y/N] ' "$1"
  read -r reply || true
  case "${reply}" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# version_ge A B  -> 0 if A >= B (dotted numeric compare).
version_ge() {
  [ "$1" = "$2" ] && return 0
  local lo
  lo="$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)"
  [ "${lo}" = "$2" ]
}

# =============================================================================
# PHASE 0 — preflight (read-only; mutate nothing; abort early)
# =============================================================================
NEED_NODE_INSTALL=0
NEED_ACL_INSTALL=0
NEED_MDADM_INSTALL=0
NEED_BTRFS_INSTALL=0
FATAL=()

phase0_preflight() {
  log "Preflight checks (no changes will be made)..."

  # Version transition (10.10): what's installed now vs what this release is.
  NEW_VERSION="unknown"
  [ -f "${SCRIPT_DIR}/VERSION" ] && NEW_VERSION="$(cat "${SCRIPT_DIR}/VERSION")"
  OLD_VERSION=""
  if [ -f "${PREFIX}/VERSION" ]; then
    OLD_VERSION="$(cat "${PREFIX}/VERSION")"
  elif [ -e "${PREFIX}" ]; then
    OLD_VERSION="unknown"   # pre-10.10 install: no VERSION on disk
  fi
  if [ -z "${OLD_VERSION}" ]; then
    info "fresh install: ANAS ${NEW_VERSION}"
  elif [ "${OLD_VERSION}" = "${NEW_VERSION}" ]; then
    info "reinstall: ANAS ${NEW_VERSION} (same version)"
  elif [ "${NEW_VERSION}" != "unknown" ] && [ "${OLD_VERSION}" != "unknown" ] \
       && ! version_ge "${NEW_VERSION}" "${OLD_VERSION}"; then
    warn "DOWNGRADE: installed ANAS is ${OLD_VERSION}, this release is ${NEW_VERSION}"
    confirm "Continue with downgrade to ${NEW_VERSION}?" \
      || { err "downgrade declined — the node was NOT modified"; exit 1; }
  else
    info "upgrade: ANAS ${OLD_VERSION} -> ${NEW_VERSION}"
  fi

  # Layout sanity — the release must be intact.
  [ -d "${APP_SRC}" ]  || FATAL+=("release incomplete: app/ not found next to install.sh")
  [ -f "${UNIT_SRC}/anasd.service" ] && [ -f "${UNIT_SRC}/anas.service" ] \
    || FATAL+=("release incomplete: systemd/ unit files not found")
  [ -f "${SCRIPT_DIR}/anas-md-event.sh" ] \
    || FATAL+=("release incomplete: anas-md-event.sh not found next to install.sh")
  [ -f "${SCRIPT_DIR}/templates/anas-ahr-subject.txt.hbs" ] && [ -f "${SCRIPT_DIR}/templates/anas-ahr-body.txt.hbs" ] \
    || FATAL+=("release incomplete: templates/anas-ahr-*.txt.hbs not found next to install.sh")

  # Root.
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    FATAL+=("must run as root (EUID 0) — try: sudo ./install.sh")
  fi

  # Proxmox VE node.
  if [ ! -f /usr/share/pve-manager/index.html.tpl ] || ! command -v pveversion >/dev/null 2>&1; then
    FATAL+=("this does not look like a Proxmox VE node (missing pveversion or /usr/share/pve-manager/index.html.tpl)")
  else
    info "PVE node detected: $(pveversion 2>/dev/null | head -n1)"
  fi

  # Node.js >= MIN_NODE_MAJOR.
  if command -v "${NODE_BIN}" >/dev/null 2>&1; then
    local nv major
    nv="$("${NODE_BIN}" --version 2>/dev/null || echo v0)"   # e.g. v22.11.0
    major="${nv#v}"; major="${major%%.*}"
    if [ "${major:-0}" -ge "${MIN_NODE_MAJOR}" ] 2>/dev/null; then
      info "Node.js ${nv} (>= ${MIN_NODE_MAJOR}) OK"
    else
      if [ "${INSTALL_DEPS}" -eq 1 ]; then
        NEED_NODE_INSTALL=1
        info "Node.js ${nv} too old (< ${MIN_NODE_MAJOR}) — will install via NodeSource (--install-deps)"
      else
        FATAL+=("Node.js ${nv} is too old (need >= ${MIN_NODE_MAJOR}). Re-run with --install-deps, or install it:
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs")
      fi
    fi
  else
    if [ "${INSTALL_DEPS}" -eq 1 ]; then
      NEED_NODE_INSTALL=1
      info "Node.js not found — will install via NodeSource (--install-deps)"
    else
      FATAL+=("Node.js not found (need >= ${MIN_NODE_MAJOR}). Re-run with --install-deps, or install it:
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs")
    fi
  fi

  # ZFS >= MIN_ZFS (ANAS depends on 'zpool -j' JSON, new in 2.2).
  local zver=""
  if command -v zpool >/dev/null 2>&1; then
    # `zpool version` prints e.g. "zfs-2.2.6\nzfs-kmod-2.2.6"
    zver="$(zpool version 2>/dev/null | head -n1 | grep -oE '[0-9]+(\.[0-9]+)+' | head -n1 || true)"
  fi
  if [ -z "${zver}" ] && [ -r /sys/module/zfs/version ]; then
    zver="$(grep -oE '[0-9]+(\.[0-9]+)+' /sys/module/zfs/version | head -n1 || true)"
  fi
  if [ -z "${zver}" ]; then
    if [ "${FORCE}" -eq 1 ]; then
      warn "could not determine ZFS version — proceeding due to --force"
    else
      FATAL+=("could not determine ZFS version (need >= ${MIN_ZFS} for 'zpool -j'). Use --force to override.")
    fi
  elif version_ge "${zver}" "${MIN_ZFS}"; then
    info "ZFS ${zver} (>= ${MIN_ZFS}) OK"
  else
    if [ "${FORCE}" -eq 1 ]; then
      warn "ZFS ${zver} is < ${MIN_ZFS} — proceeding due to --force (JSON output may be unavailable)"
    else
      FATAL+=("ZFS ${zver} is too old (need >= ${MIN_ZFS} for 'zpool -j'). Use --force to override.")
    fi
  fi

  # acl / setfacl — required for named-principal POSIX ACL grants. Tiny/standard;
  # mark for auto-install (performed after preflight passes, before Phase 1).
  if command -v setfacl >/dev/null 2>&1; then
    info "acl (setfacl) present"
  else
    NEED_ACL_INSTALL=1
    info "acl (setfacl) missing — will auto-install"
  fi

  # mdadm / btrfs-progs — required for AHR (hybrid RAID) pools. PVE 9 ships
  # neither (AHR ground truth GT-1); standard Debian packages, mark for
  # auto-install (performed after preflight passes, before Phase 1).
  if command -v mdadm >/dev/null 2>&1; then
    info "mdadm present"
  else
    NEED_MDADM_INSTALL=1
    info "mdadm missing — will auto-install"
  fi
  if command -v mkfs.btrfs >/dev/null 2>&1; then
    info "btrfs-progs (mkfs.btrfs) present"
  else
    NEED_BTRFS_INSTALL=1
    info "btrfs-progs (mkfs.btrfs) missing — will auto-install"
  fi

  # Per-protocol tools — warn only (operator chooses which to run).
  command -v smbd     >/dev/null 2>&1 || warn "smbd (samba) not found — SMB shares will not work until samba is installed."
  command -v exportfs >/dev/null 2>&1 || warn "exportfs (nfs-kernel-server) not found — NFS shares will not work until nfs-kernel-server is installed."

  # Port already in use? On an in-place upgrade the listener is our own
  # gateway (stopped in Phase 1 before the copy) — that's routine, not a
  # warning; only a FOREIGN listener deserves one.
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -qE "[:.]${HEALTH_PORT}[[:space:]]"; then
    if systemctl is-active --quiet anas 2>/dev/null; then
      info "existing ANAS gateway is listening on :${HEALTH_PORT} — it will be stopped and upgraded"
    else
      warn "something is already LISTENing on :${HEALTH_PORT} — the gateway may fail to bind."
    fi
  fi

  # Abort if any hard failure. Nothing has been mutated up to this point.
  if [ "${#FATAL[@]}" -gt 0 ]; then
    echo >&2
    err "preflight failed — the node was NOT modified:"
    local f
    for f in "${FATAL[@]}"; do printf '  - %s\n' "${f}" >&2; done
    exit 1
  fi
  log "Preflight OK."
}

# Perform opted-in dependency installs (Node via NodeSource, acl). This mutates
# the system but only adds standard packages the operator asked for; it is NOT
# rolled back on a later failure (leaving deps installed is harmless).
phase0b_install_deps() {
  if [ "${NEED_NODE_INSTALL}" -eq 1 ]; then
    log "Installing Node.js 22 via NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
    command -v "${NODE_BIN}" >/dev/null 2>&1 || { err "Node.js install failed"; exit 1; }
    info "Node.js $("${NODE_BIN}" --version) installed"
  fi
  if [ "${NEED_ACL_INSTALL}" -eq 1 ]; then
    log "Installing acl..."
    apt-get install -y acl
    command -v setfacl >/dev/null 2>&1 || { err "acl install failed (setfacl still missing)"; exit 1; }
    info "acl installed"
  fi
  if [ "${NEED_MDADM_INSTALL}" -eq 1 ] || [ "${NEED_BTRFS_INSTALL}" -eq 1 ]; then
    log "Installing mdadm + btrfs-progs..."
    # noninteractive: mdadm's postinst debconf-prompts about boot arrays/MAILADDR.
    DEBIAN_FRONTEND=noninteractive apt-get install -y mdadm btrfs-progs
    command -v mdadm      >/dev/null 2>&1 || { err "mdadm install failed"; exit 1; }
    command -v mkfs.btrfs >/dev/null 2>&1 || { err "btrfs-progs install failed (mkfs.btrfs still missing)"; exit 1; }
    info "mdadm + btrfs-progs installed"
  fi
}

# =============================================================================
# PHASE 1 — transactional install (ERR trap -> rollback)
# =============================================================================
# Step-completion flags consulted by rollback(). Each rollback action tolerates
# the step not having happened (idempotent).
SERVICES_STOPPED=0
BACKUP_PATH=""
PREFIX_INSTALLED=0
HOOK_INSTALLED=0
UNITS_INSTALLED=0
SERVICES_STARTED=0
UI_INSTALLED=0
INSTALL_DONE=0

# mdadm --monitor PROGRAM hook (AHR md events -> journald). Overridable for tests.
HOOK_DEST="${HOOK_DEST:-/usr/local/bin/anas-md-event}"

rollback() {
  set +e
  echo >&2
  err "installation failed — rolling back..."

  # Reverse order of Phase 1.
  if [ "${UI_INSTALLED}" -eq 1 ] && [ -x "${PREFIX}/packages/pve-integration/uninstall.sh" ]; then
    info "reverting PVE UI integration"
    PVE_TPL="${PVE_TPL:-}" PVE_JS_DIR="${PVE_JS_DIR:-}" APT_HOOK="${APT_HOOK:-}" \
      "${PREFIX}/packages/pve-integration/uninstall.sh" >/dev/null 2>&1 || true
  fi

  if [ "${UNITS_INSTALLED}" -eq 1 ] || [ "${SERVICES_STARTED}" -eq 1 ]; then
    info "removing systemd units"
    systemctl disable --now anasd anas >/dev/null 2>&1 || true
    rm -f "${SYSTEMD_DIR}/anasd.service" "${SYSTEMD_DIR}/anas.service"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi

  if [ "${HOOK_INSTALLED}" -eq 1 ]; then
    info "removing md-event hook"
    rm -f "${HOOK_DEST}"
  fi

  if [ "${PREFIX_INSTALLED}" -eq 1 ]; then
    info "removing freshly-installed ${PREFIX}"
    rm -rf "${PREFIX}"
  fi

  if [ -n "${BACKUP_PATH}" ] && [ -d "${BACKUP_PATH}" ]; then
    info "restoring previous install from backup"
    rm -rf "${PREFIX}"
    mv "${BACKUP_PATH}" "${PREFIX}" || true
    # Re-establish units pointing at the restored copy and bring it back up.
    install_units >/dev/null 2>&1 || true
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl restart anasd anas >/dev/null 2>&1 || true
  fi

  echo >&2
  err "installation failed — rolled back (node unchanged)."
  exit 1
}

# Copy the unit files into place, substituting PREFIX for the default /opt/anas
# ExecStart path so a custom --prefix works. daemon-reload is the caller's job.
install_units() {
  local u
  for u in anasd anas; do
    sed "s#/opt/anas#${PREFIX}#g" "${UNIT_SRC}/${u}.service" > "${SYSTEMD_DIR}/${u}.service"
    chmod 0644 "${SYSTEMD_DIR}/${u}.service"
  done
}

# Health check: services active AND the gateway answers on the port. Any HTTP
# response (even 401/404) means it is up. Returns 0 if healthy.
health_check() {
  systemctl is-active --quiet anasd || { err "anasd is not active"; journalctl -u anasd -n 20 --no-pager >&2 || true; return 1; }
  systemctl is-active --quiet anas  || { err "anas is not active";  journalctl -u anas  -n 20 --no-pager >&2 || true; return 1; }

  local code="" i
  for i in $(seq 1 10); do
    # PVE certs -> HTTPS; try https first (self-signed -> -k), then http.
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://127.0.0.1:${HEALTH_PORT}/api/health" 2>/dev/null || true)"
    if [ "${code}" = "000" ] || [ -z "${code}" ]; then
      code="$(curl -s  -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${HEALTH_PORT}/api/health" 2>/dev/null || true)"
    fi
    if [ -n "${code}" ] && [ "${code}" != "000" ]; then
      info "gateway responded on :${HEALTH_PORT} (HTTP ${code})"
      return 0
    fi
    sleep 1
  done
  err "gateway did not answer on :${HEALTH_PORT} (last curl code: ${code:-none})"
  journalctl -u anas -n 20 --no-pager >&2 || true
  return 1
}

phase1_install() {
  trap rollback ERR
  log "Installing ANAS to ${PREFIX} ..."

  # 1. If PREFIX exists: stop services (if active) and back it up.
  if [ -e "${PREFIX}" ]; then
    if systemctl is-active --quiet anasd 2>/dev/null || systemctl is-active --quiet anas 2>/dev/null; then
      info "stopping running anasd/anas"
      systemctl stop anas anasd >/dev/null 2>&1 || true
      SERVICES_STOPPED=1
    fi
    BACKUP_PATH="${PREFIX}.bak.$(date +%s)"
    info "backing up existing ${PREFIX} -> ${BACKUP_PATH}"
    mv "${PREFIX}" "${BACKUP_PATH}"
  fi

  # 2. Copy app/ -> PREFIX.
  info "copying application files"
  mkdir -p "$(dirname "${PREFIX}")"
  cp -a "${APP_SRC}" "${PREFIX}"
  PREFIX_INSTALLED=1
  # app/VERSION ships in the tarball since 10.10 and rides along in the copy;
  # fall back to the release-root copy so older tarball layouts still stamp it.
  if [ ! -f "${PREFIX}/VERSION" ] && [ -f "${SCRIPT_DIR}/VERSION" ]; then
    install -m 0644 "${SCRIPT_DIR}/VERSION" "${PREFIX}/VERSION"
  fi
  chmod +x "${PREFIX}/packages/pve-integration/install.sh" \
           "${PREFIX}/packages/pve-integration/uninstall.sh" 2>/dev/null || true

  # 2b. Install the mdadm md-event hook (AHR §7.2). Inert until the daemon
  # wires a PROGRAM line in mdadm.conf at pool-create time. Idempotent
  # overwrite on upgrade; a fresh install's rollback removes it.
  info "installing md-event hook -> ${HOOK_DEST}"
  [ -e "${HOOK_DEST}" ] || HOOK_INSTALLED=1
  install -m 0755 "${SCRIPT_DIR}/anas-md-event.sh" "${HOOK_DEST}"

  # 2c. Install the ANAS notification templates (AHR §7.2, GT-17). They live
  # in pve-manager's template dir, so a pve-manager upgrade can wipe them —
  # the DPkg::Post-Invoke apt hook re-runs this installer (same protection as
  # index.html.tpl). Overridable for tests.
  PVE_TEMPLATE_DIR="${PVE_TEMPLATE_DIR:-/usr/share/pve-manager/templates/default}"
  if [ -d "$(dirname "${PVE_TEMPLATE_DIR}")" ]; then
    info "installing PVE notification templates -> ${PVE_TEMPLATE_DIR}"
    install -d "${PVE_TEMPLATE_DIR}"
    install -m 0644 "${SCRIPT_DIR}/templates/anas-ahr-subject.txt.hbs" "${PVE_TEMPLATE_DIR}/"
    install -m 0644 "${SCRIPT_DIR}/templates/anas-ahr-body.txt.hbs" "${PVE_TEMPLATE_DIR}/"
  fi

  # 3. Install units, enable, (re)start.
  info "installing systemd units"
  install_units
  systemctl daemon-reload
  UNITS_INSTALLED=1
  systemctl enable anasd anas >/dev/null 2>&1
  info "starting services"
  systemctl restart anasd anas
  SERVICES_STARTED=1

  # 4. Health check (fails -> ERR trap -> rollback).
  info "waiting for health check"
  health_check

  # 5. PVE UI integration (injection + apt hook), then verify it landed.
  # First keep a byte-perfect copy of the ONLY Proxmox-owned file we edit
  # (index.html.tpl) — captured ONCE, as the pristine pre-ANAS original, before
  # the surgical <script> insert. The uninstall reverts the line surgically, but
  # this is the belt-and-suspenders original to restore by hand if ever needed.
  local tpl="${PVE_TPL:-/usr/share/pve-manager/index.html.tpl}"
  if [ -f "${tpl}" ] && ! grep -qF '/pve2/js/anas.js' "${tpl}" && [ ! -f "${tpl}.anas-orig" ]; then
    cp -a "${tpl}" "${tpl}.anas-orig"
    info "saved pristine template -> ${tpl}.anas-orig"
  fi
  info "installing PVE UI integration"
  "${PREFIX}/packages/pve-integration/install.sh"
  UI_INSTALLED=1
  local js_dir="${PVE_JS_DIR:-/usr/share/pve-manager/js}"
  [ -f "${js_dir}/anas.js" ] || { err "UI verify: ${js_dir}/anas.js missing"; return 1; }
  grep -qF '/pve2/js/anas.js' "${tpl}" || { err "UI verify: script line not present in ${tpl}"; return 1; }
  info "UI integration verified"

  INSTALL_DONE=1
  trap - ERR
}

finish_success() {
  # Drop the backup — the new install is healthy.
  if [ -n "${BACKUP_PATH}" ] && [ -d "${BACKUP_PATH}" ]; then
    rm -rf "${BACKUP_PATH}"
  fi
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "${ip}" ] || ip="<node-ip>"
  echo
  log "ANAS ${NEW_VERSION} installed — https://${ip}:${HEALTH_PORT}"
  echo
  info "FIRST RUN — trust the gateway certificate:"
  info "  ANAS's gateway serves HTTPS on :${HEALTH_PORT} using this node's PVE"
  info "  certificate. Browsers scope trust per host:port, so even though you've"
  info "  accepted the cert for the PVE UI on :8006, you must ALSO trust :${HEALTH_PORT}"
  info "  or ANAS shows \"not reachable\". Do ONE of:"
  info "    - open https://${ip}:${HEALTH_PORT}/ once and accept the certificate, OR"
  info "    - import the PVE cluster CA (/etc/pve/pve-root-ca.pem) into your browser"
  info "      (trusts :8006 and :${HEALTH_PORT} together), OR"
  info "    - install a browser-trusted cert on PVE (ACME / pveproxy-ssl.pem) — the"
  info "      gateway auto-inherits it."
  echo
  info "to remove: sudo ${SCRIPT_DIR}/uninstall.sh"
}

# --- main -------------------------------------------------------------------
phase0_preflight
phase0b_install_deps
phase1_install
finish_success
