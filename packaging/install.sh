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

# Gateway loopback port (issue #2). NODE-LOCAL, operator-configurable. The
# resolved value is written to ANAS_ENV_FILE (read by both anas.service via
# EnvironmentFile and AnasProxy.pm) and drives the post-install health check.
# ss/systemctl are indirected so the resolution logic is unit-testable.
ANAS_ENV_FILE="${ANAS_ENV_FILE:-/etc/default/anas}"
DEFAULT_PORT=3000
SS_BIN="${SS_BIN:-ss}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
PORT_FLAG=""            # set by --port; explicit operator intent
RESOLVED_PORT=""        # filled by resolve_port()
# HEALTH_PORT is derived from the resolved port (retires the old standalone
# HEALTH_PORT that was never plumbed into the service — issue #2). Still
# overridable for tests, but normally set by resolve_port().
HEALTH_PORT="${HEALTH_PORT:-}"

# Flags.
INSTALL_DEPS=0
ASSUME_YES=0
FORCE=0

MIN_NODE_MAJOR=20
MIN_ZFS="2.2"

# The PVE notification templates ANAS ships (one subject/body pair per event
# TYPE, so operators can match on the kind of event): anas-ahr = array/pool
# events (AHR §7.2), anas-backup = backup-run results (16.12), anas-snapshot =
# snapshot-schedule run failures and anas-replication = replication run
# failures (9.4). Listed once — the preflight check and the install step both
# read this list, and uninstall.sh removes exactly the same names.
NOTIFY_TEMPLATES=(
  anas-ahr-subject.txt.hbs
  anas-ahr-body.txt.hbs
  anas-backup-subject.txt.hbs
  anas-backup-body.txt.hbs
  anas-snapshot-subject.txt.hbs
  anas-snapshot-body.txt.hbs
  anas-replication-subject.txt.hbs
  anas-replication-body.txt.hbs
)

# The iSCSI boot-ordering drop-in (story iscsi.5). rtslib-fb-targetctl.service
# belongs to python3-rtslib-fb; ANAS never edits it, it adds this drop-in beside
# it so an apt upgrade of the package cannot lose the ordering and uninstall.sh
# has exactly one file to remove. Listed once — the preflight completeness check,
# the install step and uninstall.sh all read these two names.
ISCSI_DROPIN_DIR="rtslib-fb-targetctl.service.d"
ISCSI_DROPIN_FILE="anas-ordering.conf"

log()  { printf '==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
err()  { printf 'ERROR: %s\n' "$*" >&2; }

usage() {
  cat <<EOF
ANAS installer

Usage: sudo ./install.sh [options]

Options:
  --install-deps   Auto-install Node.js (>= ${MIN_NODE_MAJOR}) via the NodeSource setup_22.x
                   repository if it is absent or too old. Everything else ANAS
                   requires (acl, mdadm, btrfs-progs, samba, nfs-kernel-server,
                   targetcli-fb, python3-rtslib-fb) is a HARD dependency and is
                   installed regardless of this flag.
  --yes            Non-interactive; assume "yes" to prompts.
  --prefix DIR     Install location (default: /opt/anas).
  --port N         Loopback port for the ANAS gateway (default: ${DEFAULT_PORT}).
                   Written to ${ANAS_ENV_FILE}. Use this when another service
                   already holds ${DEFAULT_PORT}. An existing configured port is
                   preserved across upgrades unless --port is given.
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
    --port)         shift; [ "$#" -gt 0 ] || { err "--port needs an argument"; exit 2; }; PORT_FLAG="$1" ;;
    --port=*)       PORT_FLAG="${1#*=}" ;;
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
# Gateway port resolution (issue #2) — NODE-LOCAL, unit-testable.
# =============================================================================

# valid_port N -> 0 if N is an integer in 1..65535.
valid_port() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

# read_env_port FILE -> echo the ANAS_PORT value from an existing env file (last
# valid assignment wins, shell semantics), or nothing. Tolerates 'export ',
# quotes, inline '#' comments and whitespace.
read_env_port() {
  local f="$1" line val
  [ -f "${f}" ] || return 0
  line="$(grep -E '^[[:space:]]*(export[[:space:]]+)?ANAS_PORT[[:space:]]*=' "${f}" 2>/dev/null | tail -n1)" || true
  [ -n "${line}" ] || return 0
  val="${line#*=}"
  val="${val%%#*}"                      # strip inline comment
  val="${val#\"}"; val="${val%\"}"      # strip surrounding double quotes
  val="${val#\'}"; val="${val%\'}"      # strip surrounding single quotes
  val="$(printf '%s' "${val}" | tr -d '[:space:]')"
  valid_port "${val}" || return 0
  printf '%s' "${val}"
}

# our_configured_port -> the port THIS node's ANAS currently uses: the env-file
# value, or the legacy default 3000 when no env file exists yet (upgrades from a
# pre-env-file install ran on 3000).
our_configured_port() {
  local p
  p="$(read_env_port "${ANAS_ENV_FILE}")"
  [ -n "${p}" ] && { printf '%s' "${p}"; return 0; }
  printf '%s' "${DEFAULT_PORT}"
}

# port_listening N -> 0 if something is LISTENing on N (via SS_BIN). If ss is
# unavailable we cannot tell -> treat as free (return 1), matching the prior
# best-effort behaviour.
port_listening() {
  local p="$1" out
  command -v "${SS_BIN}" >/dev/null 2>&1 || return 1
  # Capture the listing FIRST, then match against a here-string (issue #21).
  # Piping ss straight into `grep -q` lets grep exit on its first hit, killing ss
  # with SIGPIPE (exit 141), which `set -o pipefail` then reports as a pipeline
  # FAILURE — i.e. "port free" for a port that is demonstrably listening. On a
  # short listing ss usually finishes writing before grep exits, so the bug only
  # shows up when the listing is long: a genuinely intermittent wrong answer
  # about a port conflict, and an intermittent escape of the conflict guard. No
  # pipe, no race. `|| true` keeps a non-zero ss from tripping `set -e`.
  out="$("${SS_BIN}" -ltn 2>/dev/null || true)"
  grep -qE "[:.]${p}[[:space:]]" <<<"${out}"
}

# ours_on_port N -> 0 if a listener on N belongs to OUR gateway (the anas
# service is active AND N is our configured port). Used so an in-place upgrade's
# own listener is never mistaken for a foreign conflict.
ours_on_port() {
  local p="$1"
  "${SYSTEMCTL_BIN}" is-active --quiet anas 2>/dev/null || return 1
  [ "${p}" = "$(our_configured_port)" ]
}

# Resolve the gateway port into RESOLVED_PORT, with precedence (issue #2):
#   1. --port N wins; a FOREIGN listener on it is a hard error (respect intent).
#   2. else an existing ${ANAS_ENV_FILE} value is preserved (upgrades never re-pick).
#   3. else default ${DEFAULT_PORT}; on a fresh install, if it is FOREIGN-held,
#      auto-scan upward to the first free port and log the choice loudly.
resolve_port() {
  local existing
  existing="$(read_env_port "${ANAS_ENV_FILE}")"

  # 1. Explicit operator intent.
  if [ -n "${PORT_FLAG}" ]; then
    if ! valid_port "${PORT_FLAG}"; then
      err "--port '${PORT_FLAG}' is not a valid port (1-65535)"
      exit 2
    fi
    if port_listening "${PORT_FLAG}" && ! ours_on_port "${PORT_FLAG}"; then
      err "--port ${PORT_FLAG} is already in use by another listener on this node."
      err "Refusing to silently choose a different port. Free :${PORT_FLAG} or pass a different --port."
      exit 1
    fi
    RESOLVED_PORT="${PORT_FLAG}"
    info "gateway port: ${RESOLVED_PORT} (from --port)"
    return 0
  fi

  # 2. Preserve an already-configured port across upgrades.
  if [ -n "${existing}" ]; then
    RESOLVED_PORT="${existing}"
    info "gateway port: ${RESOLVED_PORT} (preserved from ${ANAS_ENV_FILE})"
    return 0
  fi

  # 3. Fresh install: default, auto-scanning past a foreign listener.
  local candidate="${DEFAULT_PORT}" scan
  if port_listening "${candidate}" && ! ours_on_port "${candidate}"; then
    for scan in $(seq $((DEFAULT_PORT + 1)) $((DEFAULT_PORT + 99))); do
      if ! port_listening "${scan}"; then candidate="${scan}"; break; fi
    done
    if port_listening "${candidate}"; then
      err "port ${DEFAULT_PORT} is in use and no free port was found in ${DEFAULT_PORT}-$((DEFAULT_PORT + 99))."
      err "Specify one explicitly with --port N."
      exit 1
    fi
    warn "port ${DEFAULT_PORT} is already in use by another process on this node."
    warn "ANAS gateway will use :${candidate} instead (written to ${ANAS_ENV_FILE})."
  fi
  RESOLVED_PORT="${candidate}"
  info "gateway port: ${RESOLVED_PORT} (default)"
}

# Write the ANAS-owned env file consumed by anas.service (EnvironmentFile) and
# AnasProxy.pm. Fresh each install from the resolved port (the file is ours).
write_env_file() {
  local port="$1"
  install -d -m 0755 "$(dirname "${ANAS_ENV_FILE}")"
  cat > "${ANAS_ENV_FILE}" <<EOF
# ANAS gateway configuration — managed by install.sh (issue #2). KEY=VALUE.
# Loopback port the anas gateway binds and pveproxy forwards /anas requests to.
# NODE-LOCAL: each node has its own value; nothing here is cluster-wide.
ANAS_PORT=${port}
EOF
  chmod 0644 "${ANAS_ENV_FILE}"
  info "wrote ${ANAS_ENV_FILE} (ANAS_PORT=${port})"
}

# =============================================================================
# PHASE 0 — preflight (read-only; mutate nothing; abort early)
# =============================================================================
NEED_NODE_INSTALL=0
NEED_ACL_INSTALL=0
NEED_MDADM_INSTALL=0
NEED_BTRFS_INSTALL=0
NEED_SAMBA_INSTALL=0
NEED_NFS_INSTALL=0
NEED_TARGETCLI_INSTALL=0
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
  [ -f "${UNIT_SRC}/${ISCSI_DROPIN_DIR}/${ISCSI_DROPIN_FILE}" ] \
    || FATAL+=("release incomplete: systemd/${ISCSI_DROPIN_DIR}/${ISCSI_DROPIN_FILE} not found next to install.sh")
  for tpl in "${NOTIFY_TEMPLATES[@]}"; do
    [ -f "${SCRIPT_DIR}/templates/${tpl}" ] \
      || FATAL+=("release incomplete: templates/${tpl} not found next to install.sh")
  done

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

  # samba / nfs-kernel-server — required for SMB and NFS shares. PVE 9 ships
  # neither; both are standard Debian packages. ANAS does NOT gate the share
  # features on their presence — the Shares and Share Users screens are always
  # there — so the binaries they need are HARD dependencies, exactly like
  # mdadm/btrfs-progs (issue #6: a fresh node had no smbpasswd, and adding an
  # SMB share user failed with a raw `spawn /usr/bin/smbpasswd ENOENT`).
  # smbd comes from `samba`, smbpasswd from `samba-common-bin` (which `samba`
  # pulls in) — probing both catches a node with only half of the pair.
  if command -v smbd >/dev/null 2>&1 && command -v smbpasswd >/dev/null 2>&1; then
    info "samba (smbd, smbpasswd) present"
  else
    NEED_SAMBA_INSTALL=1
    info "samba (smbd/smbpasswd) missing — will auto-install"
  fi
  if command -v exportfs >/dev/null 2>&1; then
    info "nfs-kernel-server (exportfs) present"
  else
    NEED_NFS_INSTALL=1
    info "nfs-kernel-server (exportfs) missing — will auto-install"
  fi

  # targetcli-fb / python3-rtslib-fb — required to SERVE iSCSI block storage
  # (LIO, the kernel target). PVE 9 ships neither, though it does ship the
  # INITIATOR side (open-iscsi) for its own `iscsi:` storage type — ANAS never
  # touches that half. Same rule as samba/nfs: the iSCSI screen is always there,
  # not gated on the tooling, so the tooling is a HARD dependency.
  # `targetcli` comes from targetcli-fb; the python3 module import proves
  # python3-rtslib-fb, which is the half that owns the restore service and the
  # persisted /etc/rtslib-fb-target/saveconfig.json — probing both catches a node
  # with only one of the pair.
  if command -v targetcli >/dev/null 2>&1 \
     && python3 -c 'import rtslib_fb' >/dev/null 2>&1; then
    info "targetcli-fb + python3-rtslib-fb present"
  else
    NEED_TARGETCLI_INSTALL=1
    info "targetcli-fb/python3-rtslib-fb missing — will auto-install"
  fi

  # Resolve the gateway port (issue #2) before anything binds. This owns the
  # port-in-use logic: --port intent, preserving a configured port on upgrade,
  # and auto-scanning past a foreign listener on a fresh install. May exit here
  # (still read-only — nothing mutated) if --port collides with a foreign
  # listener. HEALTH_PORT is derived from the result and drives the health check.
  resolve_port
  HEALTH_PORT="${RESOLVED_PORT}"
  # On an in-place upgrade our own gateway may currently hold the port — that is
  # routine (Phase 1 stops it before the copy), not a warning.
  if port_listening "${HEALTH_PORT}" && ours_on_port "${HEALTH_PORT}"; then
    info "existing ANAS gateway is listening on :${HEALTH_PORT} — it will be stopped and upgraded"
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

# Install the dependencies preflight marked missing: Node.js via NodeSource
# (opted in with --install-deps), then the hard dependencies that are installed
# regardless — acl, mdadm + btrfs-progs, samba + nfs-kernel-server,
# targetcli-fb + python3-rtslib-fb. This mutates
# the system but only adds standard Debian packages; it is NOT rolled back on a
# later failure (leaving deps installed is harmless). It runs on every install
# AND every upgrade, so an existing node picks up a dependency added by a newer
# ANAS release the next time the installer is run.
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
    # These are a HARD dependency (AHR / Hybrid RAID) — matching the node/acl
    # pattern, they are installed at install time, never optional. Catch an apt
    # failure explicitly (set -e would otherwise abort silently) and say exactly
    # what is needed, that nothing has been changed yet, and how to preseed.
    # This runs BEFORE the rollback trap arms, so no ANAS step has touched the node.
    if ! DEBIAN_FRONTEND=noninteractive apt-get install -y mdadm btrfs-progs; then
      err "failed to install the required packages 'mdadm' and 'btrfs-progs'."
      err "ANAS requires them for AHR (Hybrid RAID) pools — they are a hard dependency, not optional."
      err "Nothing on this node was modified (this step runs before any install action)."
      err "On an air-gapped node, preseed them first (e.g. 'apt-get install -y --no-download mdadm btrfs-progs' from a local mirror, or pre-place the .deb files) and re-run this installer."
      exit 1
    fi
    command -v mdadm      >/dev/null 2>&1 || { err "mdadm install failed (mdadm still missing) — ANAS requires it for AHR/Hybrid RAID; nothing was modified"; exit 1; }
    command -v mkfs.btrfs >/dev/null 2>&1 || { err "btrfs-progs install failed (mkfs.btrfs still missing) — ANAS requires it for AHR/Hybrid RAID; nothing was modified"; exit 1; }
    info "mdadm + btrfs-progs installed"
  fi
  if [ "${NEED_SAMBA_INSTALL}" -eq 1 ] || [ "${NEED_NFS_INSTALL}" -eq 1 ]; then
    local share_pkgs=()
    [ "${NEED_SAMBA_INSTALL}" -eq 1 ] && share_pkgs+=("samba")
    [ "${NEED_NFS_INSTALL}" -eq 1 ] && share_pkgs+=("nfs-kernel-server")
    log "Installing ${share_pkgs[*]}..."
    # noninteractive: samba's postinst debconf-prompts about the workgroup/WINS
    # configuration. Same shape as mdadm/btrfs-progs above — the share features
    # are not gated on these tools being present, so they are installed at
    # install time, never optional (issue #6). Nothing here writes smb.conf or
    # /etc/exports: the packages lay down their own defaults and ANAS edits them
    # surgically from there (PRINCIPLES.md #12 — guest, not owner).
    # This runs BEFORE the rollback trap arms, so no ANAS step has touched the node.
    if ! DEBIAN_FRONTEND=noninteractive apt-get install -y "${share_pkgs[@]}"; then
      err "failed to install the required package(s) '${share_pkgs[*]}'."
      err "ANAS requires them for SMB/NFS shares and share users — the share screens are always available, so they are a hard dependency, not optional."
      err "Nothing on this node was modified (this step runs before any install action)."
      err "On an air-gapped node, preseed them first (e.g. 'apt-get install -y --no-download ${share_pkgs[*]}' from a local mirror, or pre-place the .deb files) and re-run this installer."
      exit 1
    fi
    if [ "${NEED_SAMBA_INSTALL}" -eq 1 ]; then
      command -v smbd      >/dev/null 2>&1 || { err "samba install failed (smbd still missing) — ANAS requires it for SMB shares; nothing was modified"; exit 1; }
      command -v smbpasswd >/dev/null 2>&1 || { err "samba install failed (smbpasswd still missing) — ANAS requires it for SMB share users; nothing was modified"; exit 1; }
    fi
    if [ "${NEED_NFS_INSTALL}" -eq 1 ]; then
      command -v exportfs >/dev/null 2>&1 || { err "nfs-kernel-server install failed (exportfs still missing) — ANAS requires it for NFS exports; nothing was modified"; exit 1; }
    fi
    info "${share_pkgs[*]} installed"
    info "note: these packages enable and start their own services (smbd / nfs-server)"
  fi
  if [ "${NEED_TARGETCLI_INSTALL}" -eq 1 ]; then
    log "Installing targetcli-fb + python3-rtslib-fb..."
    # Same shape as samba/nfs above: the iSCSI screen is always available, so
    # the tooling is a hard dependency, not optional. Nothing here writes any
    # LIO configuration — the packages lay down their own empty state and ANAS
    # edits it through targetcli from there (PRINCIPLES.md #12 — guest, not
    # owner). This runs BEFORE the rollback trap arms, so no ANAS step has
    # touched the node.
    if ! DEBIAN_FRONTEND=noninteractive apt-get install -y targetcli-fb python3-rtslib-fb; then
      err "failed to install the required packages 'targetcli-fb' and 'python3-rtslib-fb'."
      err "ANAS requires them to serve iSCSI block storage (LIO) — the iSCSI screen is always available, so they are a hard dependency, not optional."
      err "Nothing on this node was modified (this step runs before any install action)."
      err "On an air-gapped node, preseed them first (e.g. 'apt-get install -y --no-download targetcli-fb python3-rtslib-fb' from a local mirror, or pre-place the .deb files) and re-run this installer."
      exit 1
    fi
    command -v targetcli >/dev/null 2>&1 \
      || { err "targetcli-fb install failed (targetcli still missing) — ANAS requires it to serve iSCSI block storage; nothing was modified"; exit 1; }
    python3 -c 'import rtslib_fb' >/dev/null 2>&1 \
      || { err "python3-rtslib-fb install failed (the rtslib_fb module is still missing) — ANAS requires it for the LIO boot restore; nothing was modified"; exit 1; }
    info "targetcli-fb + python3-rtslib-fb installed"
    # Deliberately NOT enabled or started here: the python3-rtslib-fb postinst
    # already symlinks rtslib-fb-targetctl.service into
    # multi-user.target.wants/ and starts it (it exits immediately with "No
    # saved config file at /etc/rtslib-fb-target/saveconfig.json, ok, exiting").
    # ANAS's only job on that unit is the ordering drop-in, installed in Phase 1.
    info "note: python3-rtslib-fb enables and starts rtslib-fb-targetctl.service itself"
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
ENV_FILE_FRESH=0        # set iff we CREATED ${ANAS_ENV_FILE} (removed on rollback)
ISCSI_DROPIN_FRESH=0    # set iff we CREATED the iSCSI ordering drop-in (removed on rollback)
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

  # Only a drop-in THIS run created is withdrawn; an upgrade over an existing
  # one leaves it in place (the restore path below re-installs it anyway).
  if [ "${ISCSI_DROPIN_FRESH}" -eq 1 ]; then
    info "removing iSCSI ordering drop-in"
    rm -f "${SYSTEMD_DIR}/${ISCSI_DROPIN_DIR}/${ISCSI_DROPIN_FILE}"
    rmdir "${SYSTEMD_DIR}/${ISCSI_DROPIN_DIR}" >/dev/null 2>&1 || true
  fi

  if [ "${ENV_FILE_FRESH}" -eq 1 ]; then
    info "removing freshly-written ${ANAS_ENV_FILE}"
    rm -f "${ANAS_ENV_FILE}"
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
  install_iscsi_dropin
}

# Install the iSCSI boot-ordering drop-in (story iscsi.5).
#
# rtslib-fb-targetctl.service is python3-rtslib-fb's, and ANAS is a guest: the
# vendor unit is never edited, a drop-in is added beside it. The unit's own
# ordering stops at local-fs.target, so nothing waits for /dev/zvol/* — and a
# restore whose backing device is missing reports systemd SUCCESS while the LUN
# silently vanishes (ISCSI-GROUND-TRUTH GT-3/GT-20/GT-21). The drop-in prevents
# the race; the `iscsi` dashboard warnings catch whatever still slips through.
#
# Idempotent: a plain overwrite, so a re-run (upgrade) re-applies the current
# content over an older one. It is installed unconditionally — the unit may not
# exist yet in the same run that apt is installing the package, and a drop-in
# for a not-yet-present unit is inert, not an error. daemon-reload is the
# caller's job (Phase 1 does one for the ANAS units anyway, and it covers this).
install_iscsi_dropin() {
  [ -e "${SYSTEMD_DIR}/${ISCSI_DROPIN_DIR}/${ISCSI_DROPIN_FILE}" ] || ISCSI_DROPIN_FRESH=1
  install -d -m 0755 "${SYSTEMD_DIR}/${ISCSI_DROPIN_DIR}"
  install -m 0644 "${UNIT_SRC}/${ISCSI_DROPIN_DIR}/${ISCSI_DROPIN_FILE}" \
    "${SYSTEMD_DIR}/${ISCSI_DROPIN_DIR}/${ISCSI_DROPIN_FILE}"
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
    for tpl in "${NOTIFY_TEMPLATES[@]}"; do
      install -m 0644 "${SCRIPT_DIR}/templates/${tpl}" "${PVE_TEMPLATE_DIR}/"
    done
  fi

  # 2d. Write the ANAS-owned gateway env file (issue #2) BEFORE the service
  # starts, so anas.service's EnvironmentFile and AnasProxy.pm both read the
  # resolved port. Track whether we created it so rollback removes only a file
  # we introduced (an upgrade's pre-existing file is left in place).
  [ -e "${ANAS_ENV_FILE}" ] || ENV_FILE_FRESH=1
  write_env_file "${RESOLVED_PORT}"

  # 3. Install units, enable, (re)start. install_units also lays down the iSCSI
  # boot-ordering drop-in (iscsi.5) — a drop-in beside the vendor unit, never an
  # edit of it — and the daemon-reload below is what makes it take effect.
  info "installing systemd units"
  install_units
  info "installed iSCSI ordering drop-in -> ${SYSTEMD_DIR}/${ISCSI_DROPIN_DIR}/${ISCSI_DROPIN_FILE}"
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
  log "ANAS ${NEW_VERSION} installed — https://${ip}:8006 (the normal PVE web UI)"
  echo
  info "ANAS panels appear inside the Proxmox web UI you already use. The API is"
  info "served through pveproxy on :8006 under /anas, so there is no separate"
  info "origin and NO extra certificate to trust — if the PVE UI loads, ANAS does."
  info "Log in to the PVE web UI and open a node to find the ANAS section."
  echo
  info "to remove: sudo ${SCRIPT_DIR}/uninstall.sh"
}

# --- main -------------------------------------------------------------------
# ANAS_INSTALL_LIB_ONLY lets the test harness source this file to exercise the
# pure helpers (port resolution, env-file writing) without running the installer.
if [ "${ANAS_INSTALL_LIB_ONLY:-0}" != "1" ]; then
  phase0_preflight
  phase0b_install_deps
  phase1_install
  finish_success
fi
